/**
 * @module chain
 */

import assert from "assert";
import {EventEmitter} from "events";
import {clone, hashTreeRoot, serialize, signingRoot} from "@chainsafe/ssz";
import {Attestation, BeaconBlock, BeaconState, Slot, uint16, uint64, Root, bytes32} from "@chainsafe/eth2.0-types";
import {IBeaconConfig} from "@chainsafe/eth2.0-config";

import {DEPOSIT_CONTRACT_TREE_DEPTH, GENESIS_SLOT, GENESIS_EPOCH} from "../constants";
import {IBeaconDb} from "../db";
import {IEth1Notifier} from "../eth1";
import {ILogger} from "../logger";
import {IBeaconMetrics} from "../metrics";

import {getEmptyBlock, initializeBeaconStateFromEth1, isValidGenesisState} from "./genesis/genesis";

import {processSlots, stateTransition,
  computeEpochAtSlot,
  computeStartSlotAtEpoch,
  getAttestingIndices,
  isActiveValidator
  ,getCurrentSlot} from "@chainsafe/eth2.0-state-transition";
import {ILMDGHOST, StatefulDagLMDGHOST} from "./forkChoice";

import {ChainEventEmitter, IBeaconChain} from "./interface";
import {processSortedDeposits} from "../util/deposits";
import {IChainOptions} from "./options";
import {OpPool} from "../opPool";
import {Block} from "ethers/providers";
import fs from "fs";
import {AsyncQueue, queue} from "async";
import FastPriorityQueue from "fastpriorityqueue";

import {ProgressiveMerkleTree} from "@chainsafe/eth2.0-utils";
import {MerkleTreeSerialization} from "../util/serialization";

export interface IBeaconChainModules {
  config: IBeaconConfig;
  opPool: OpPool;
  db: IBeaconDb;
  eth1: IEth1Notifier;
  logger: ILogger;
  metrics: IBeaconMetrics;
}

export interface IBlockProcessJob {
  block: BeaconBlock;
  trusted: boolean;
}

export class BeaconChain extends (EventEmitter as { new(): ChainEventEmitter }) implements IBeaconChain {

  public chain: string;
  public _latestState: BeaconState = null;
  public forkChoice: ILMDGHOST;
  public chainId: uint16;
  public networkId: uint64;

  private readonly config: IBeaconConfig;
  private db: IBeaconDb;
  private opPool: OpPool;
  private eth1: IEth1Notifier;
  private logger: ILogger;
  private metrics: IBeaconMetrics;
  private opts: IChainOptions;
  private attestationProcessingQueue: AsyncQueue<Function>;
  private attesationWaitingQueue: FastPriorityQueue<Attestation>;
  private blockProcessingQueue: FastPriorityQueue<IBlockProcessJob>; //sort by slot number

  public constructor(opts: IChainOptions, {config, db, eth1, opPool, logger, metrics}: IBeaconChainModules) {
    super();
    this.opts = opts;
    this.chain = opts.name;
    this.config = config;
    this.db = db;
    this.eth1 = eth1;
    this.opPool = opPool;
    this.logger = logger;
    this.metrics = metrics;
    this.forkChoice = new StatefulDagLMDGHOST(config);
    this.chainId = 0; // TODO make this real
    this.networkId = 0n; // TODO make this real
    this.attestationProcessingQueue = queue(async (task: Function) => {
      await task();
    }, 1);
    this.attesationWaitingQueue = new FastPriorityQueue((a: Attestation, b: Attestation) => a.data.slot < b.data.slot);
    this.blockProcessingQueue = new FastPriorityQueue((a: IBlockProcessJob, b: IBlockProcessJob) => {
      return a.block.slot < b.block.slot;
    });
  }

  public async start(): Promise<void> {
    const state = this.latestState || await this.db.state.getLatest();
    this.forkChoice.start(state.genesisTime);
    // if state doesn't exist in the db, the chain maybe hasn't started
    if(!state) {
      // check every block if genesis
      this.logger.info("Chain not started, listening for genesis block");
      this.eth1.on("block", this.checkGenesis);
    }
    this.latestState = state;
    this.logger.info("Chain started, waiting blocks and attestations");
  }

  public async stop(): Promise<void> {
    await this.forkChoice.stop();
    this.eth1.removeListener("block", this.checkGenesis);
  }

  public get latestState(): BeaconState {
    return clone(this.config.types.BeaconState, this._latestState);
  }

  public set latestState(state: BeaconState) {
    this._latestState = state;
  }

  public isInitialized(): boolean {
    return !!this.latestState;
  }

  public async receiveAttestation(attestation: Attestation): Promise<void> {
    const attestationHash = hashTreeRoot(this.config.types.Attestation, attestation);
    this.logger.info(`Received attestation ${attestationHash.toString("hex")}`);
    try {
      const attestationSlot: Slot = attestation.data.slot;
      const headBlock = await this.db.block.get(this.forkChoice.head());
      const state = await this.db.state.get(headBlock.stateRoot);
      if(attestationSlot + this.config.params.SLOTS_PER_EPOCH < state.slot) {
        this.logger.verbose(`Attestation ${attestationHash.toString("hex")} is too old. Ignored.`);
        return;
      }
    } catch (e) {
      return;
    }
    const targetRoot = attestation.data.target.root;
    if (!await this.db.block.has(targetRoot)) {
      this.emit("unknownBlockRoot", targetRoot);
      this.attesationWaitingQueue.add(attestation);
      return;
    }
    const beaconBlockRoot = attestation.data.beaconBlockRoot;
    if (!await this.db.block.has(beaconBlockRoot)) {
      this.emit("unknownBlockRoot", beaconBlockRoot);
      this.attesationWaitingQueue.add(attestation);
      return;
    }
    this.attestationProcessingQueue.push(async () => {
      return this.processAttestation(attestation, attestationHash);
    });
    const nextAttestationInQueue = this.attesationWaitingQueue.peek();
    while (nextAttestationInQueue) {
      if (await this.db.block.has(nextAttestationInQueue.data.target.root) &&
          await this.db.block.has(nextAttestationInQueue.data.beaconBlockRoot)) {
        const attestationInQueuHash = hashTreeRoot(this.config.types.Attestation, nextAttestationInQueue);
        this.attestationProcessingQueue.push(async () => {
          return this.processAttestation(nextAttestationInQueue, attestationInQueuHash);
        });
        this.attesationWaitingQueue.poll();
      } else {
        return;
      }
    }
  }

  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  public async receiveBlock(block: BeaconBlock, trusted = false): Promise<void> {
    const blockHash = signingRoot(this.config.types.BeaconBlock, block);
    this.logger.info(
      `Received block with hash 0x${blockHash.toString("hex")}` +
      `at slot ${block.slot}. Current state slot ${this.latestState.slot}`
    );

    if(!await this.db.block.has(block.parentRoot)) {
      this.emit("unknownBlockRoot", block.parentRoot);
      this.blockProcessingQueue.add({block, trusted});
      return;
    }

    if(await this.db.block.has(blockHash)) {
      this.logger.warn(`Block ${blockHash} existed already, no need to process it.`);
      return;
    }

    const finalizedCheckpoint = this.forkChoice.getFinalized();
    if(block.slot <= computeStartSlotAtEpoch(this.config, finalizedCheckpoint.epoch)) {
      this.logger.warn(
        `Block ${blockHash.toString("hex")} is not after ` +
        `finalized checkpoint ${finalizedCheckpoint.root.toString("hex")}.`
      );
      return;
    }

    await this.processBlock({block, trusted: false}, blockHash);
    const nextBlockInQueue = this.blockProcessingQueue.peek();
    while (nextBlockInQueue) {
      if (await this.db.block.has(nextBlockInQueue.block.parentRoot)) {
        await this.processBlock(nextBlockInQueue, signingRoot(this.config.types.BeaconBlock, nextBlockInQueue));
        this.blockProcessingQueue.poll();
      } else{
        return;
      }
    }
  }

  public async advanceState(slot?: Slot): Promise<void> {
    const targetSlot = slot || getCurrentSlot(this.config, this.latestState.genesisTime);
    this.logger.info(`Manually advancing slot from state slot ${this.latestState.slot} to ${targetSlot} `);
    const state = this.latestState;

    try {
      processSlots(this.config, state, targetSlot);
    } catch (e) {
      this.logger.warn(`Failed to advance slot mannually because ${e.message}`);
    }
    this.latestState = state;
    await this.db.state.add(state);
    await this.db.chain.setLatestStateRoot(hashTreeRoot(this.config.types.BeaconState, state));
  }

  public async applyForkChoiceRule(): Promise<void> {
    const currentRoot = await this.db.chain.getChainHeadRoot();
    const headRoot = this.forkChoice.head();
    if (currentRoot && !currentRoot.equals(headRoot)) {
      const block = await this.db.block.get(headRoot);
      await this.db.updateChainHead(headRoot, block.stateRoot);
      this.logger.info(`Fork choice changed head to 0x${headRoot.toString("hex")}`);
    }
  }

  public async initializeBeaconChain(genesisState: BeaconState, merkleTree: ProgressiveMerkleTree): Promise<void> {
    this.logger.info(`Initializing beacon chain with genesisTime ${genesisState.genesisTime}`);
    const genesisBlock = getEmptyBlock();
    const stateRoot = hashTreeRoot(this.config.types.BeaconState, genesisState);
    genesisBlock.stateRoot = stateRoot;
    const blockRoot = signingRoot(this.config.types.BeaconBlock, genesisBlock);
    this.latestState = genesisState;
    await Promise.all([
      this.db.storeChainHead(genesisBlock, genesisState),
      this.db.chain.setJustifiedBlockRoot(blockRoot),
      this.db.chain.setFinalizedBlockRoot(blockRoot),
      this.db.chain.setJustifiedStateRoot(stateRoot),
      this.db.chain.setFinalizedStateRoot(stateRoot),
      this.db.merkleTree.set(genesisState.eth1DepositIndex, merkleTree.toObject())
    ]);
    const justifiedFinalizedCheckpoint = {root: blockRoot, epoch: computeEpochAtSlot(this.config, genesisBlock.slot)};
    this.forkChoice.addBlock(genesisBlock.slot, blockRoot, Buffer.alloc(32),
      justifiedFinalizedCheckpoint, justifiedFinalizedCheckpoint);
    this.logger.info("Beacon chain initialized");
  }

  public async isValidBlock(state: BeaconState, block: BeaconBlock): Promise<boolean> {
    // The parent block with root block.previous_block_root has been processed and accepted.
    // const hasParent = await this.db.block.has(block.parentRoot);
    // if (!hasParent) {
    //   return false;
    // }
    // An Ethereum 1.0 block pointed to by the state.
    // latest_eth1_data.block_hash has been processed and accepted.
    // TODO: implement

    // The node's Unix time is greater than or equal to state.
    const stateSlotTime = state.genesisTime + ((block.slot - GENESIS_SLOT) * this.config.params.SECONDS_PER_SLOT);
    return Math.floor(Date.now() / 1000) >= stateSlotTime;
  }

  private processAttestation = async (attestation: Attestation, attestationHash: bytes32): Promise<void> => {
    const justifiedCheckpoint = this.forkChoice.getJustified();
    const justifiedBlock = await this.db.block.get(justifiedCheckpoint.root);
    const checkpointState = await this.db.state.get(justifiedBlock.stateRoot);
    const currentSlot = getCurrentSlot(this.config, checkpointState.genesisTime);
    const currentEpoch = computeEpochAtSlot(this.config, currentSlot);
    const previousEpoch = currentEpoch > GENESIS_EPOCH ? currentEpoch - 1 : GENESIS_EPOCH;
    const target = attestation.data.target;
    assert([currentEpoch, previousEpoch].includes(target.epoch));
    assert(target.epoch === computeEpochAtSlot(this.config, attestation.data.slot));
    const block = await this.db.block.get(attestation.data.beaconBlockRoot);
    assert(block.slot <= attestation.data.slot);

    const validators = getAttestingIndices(
      this.config, checkpointState, attestation.data, attestation.aggregationBits);
    const balances = validators.map((index) => checkpointState.balances[index]);
    for (let i = 0; i < validators.length; i++) {
      this.forkChoice.addAttestation(attestation.data.beaconBlockRoot, validators[i], balances[i]);
    }
    this.logger.info(`Attestation ${attestationHash.toString("hex")} passed to fork choice`);
    this.emit("processedAttestation", attestation);
  };

  private processBlock = async (job: IBlockProcessJob, blockHash: Root): Promise<void> => {
    const parentBlock = await this.db.block.get(job.block.parentRoot);
    const pre = await this.db.state.get(parentBlock.stateRoot);
    const isValidBlock = await this.isValidBlock(pre, job.block);
    assert(isValidBlock);
    this.logger.info(`0x${blockHash.toString("hex")} is valid, running state transition...`);

    // process current slot
    const post = await this.runStateTransition(job.block, pre);

    this.logger.info(
      `Slot ${job.block.slot} Block 0x${blockHash.toString("hex")} ` +
      `State ${hashTreeRoot(this.config.types.BeaconState, post).toString("hex")} passed state transition`
    );
    await this.opPool.processBlockOperations(job.block);
    job.block.body.attestations.forEach((attestation) => {
      this.receiveAttestation(attestation);
    });

    if (this.opts.dumpState) {
      this.dumpState(job.block, pre, post);
    }

    this.metrics.currentSlot.inc(1);

    // forward processed block for additional processing
    this.emit("processedBlock", job.block);
  };

  private dumpState(block: BeaconBlock, pre: BeaconState, post: BeaconState): void {
    const baseDir = "./state-dumps/";
    const curDir = this.latestState.slot;
    const full = baseDir + curDir;
    if (!fs.existsSync(baseDir)) {
      fs.mkdirSync(baseDir);
    }

    fs.mkdirSync(baseDir + curDir);

    const sblock = serialize(this.config.types.BeaconBlock, block);
    const sPre = serialize(this.config.types.BeaconState, pre);
    const sPost = serialize(this.config.types.BeaconState, post);

    fs.writeFile(full + "/block.ssz", sblock, (e) => {
      if (e) throw e;
    });
    fs.writeFile(full + "/pre.ssz", sPre, (e) => {
      if (e) throw e;
    });
    fs.writeFile(full + "/post.ssz", sPost, (e) => {
      if (e) throw e;
    });
  }

  /**
   *
   * @param block
   * @param state
   * @param trusted if state transition should trust that block is valid
   */
  private async runStateTransition(block: BeaconBlock, state: BeaconState, trusted = false): Promise<BeaconState|null> {
    const preSlot = state.slot;
    const preFinalizedEpoch = state.finalizedCheckpoint.epoch;
    const preJustifiedEpoch = state.currentJustifiedCheckpoint.epoch;
    // Run the state transition
    let newState: BeaconState;
    const blockRoot = signingRoot(this.config.types.BeaconBlock, block);
    try {
      // if block is trusted don't verify state roots, proposer or signature
      newState = stateTransition(this.config, state, block, !trusted, !trusted, !trusted);
    } catch (e) {
      // store block root in db and terminate
      await this.db.block.storeBadBlock(blockRoot);
      this.logger.warn(`Found bad block, block root: 0x${blockRoot.toString("hex")} ` + e.message);
      return;
    }
    this.latestState = newState;
    // On successful transition, update system state
    await Promise.all([
      this.db.state.set(block.stateRoot, newState),
      this.db.block.set(blockRoot, block),
    ]);
    this.forkChoice.addBlock(block.slot, blockRoot, block.parentRoot, newState.currentJustifiedCheckpoint,
      newState.finalizedCheckpoint);
    await this.applyForkChoiceRule();
    await this.updateDepositMerkleTree(newState);
    // update metrics
    this.metrics.currentSlot.set(block.slot);

    // Post-epoch processing
    const currentEpoch = computeEpochAtSlot(this.config, newState.slot);
    if (computeEpochAtSlot(this.config, preSlot) < currentEpoch) {
      this.emit("processedCheckpoint", {epoch: currentEpoch, root: blockRoot});
      // Update FFG Checkpoints
      // Newly justified epoch
      if (preJustifiedEpoch < newState.currentJustifiedCheckpoint.epoch) {
        const justifiedBlockRoot = newState.currentJustifiedCheckpoint.root;
        const justifiedBlock = await this.db.block.get(justifiedBlockRoot);
        this.logger.important(`Epoch ${computeEpochAtSlot(this.config, justifiedBlock.slot)} is justified!`);
        await Promise.all([
          this.db.chain.setJustifiedStateRoot(justifiedBlock.stateRoot),
          this.db.chain.setJustifiedBlockRoot(justifiedBlockRoot),
        ]);
        this.emit("justifiedCheckpoint", newState.currentJustifiedCheckpoint);
      }
      // Newly finalized epoch
      if (preFinalizedEpoch < newState.finalizedCheckpoint.epoch) {
        const finalizedBlockRoot = newState.finalizedCheckpoint.root;
        const finalizedBlock = await this.db.block.get(finalizedBlockRoot);
        this.logger.important(`Epoch ${computeEpochAtSlot(this.config, finalizedBlock.slot)} is finalized!`);
        await Promise.all([
          this.db.chain.setFinalizedStateRoot(finalizedBlock.stateRoot),
          this.db.chain.setFinalizedBlockRoot(finalizedBlockRoot),
        ]);
        this.emit("finalizedCheckpoint", newState.finalizedCheckpoint);
      }
      this.metrics.previousJustifiedEpoch.set(newState.previousJustifiedCheckpoint.epoch);
      this.metrics.currentJustifiedEpoch.set(newState.currentJustifiedCheckpoint.epoch);
      this.metrics.currentFinalizedEpoch.set(newState.finalizedCheckpoint.epoch);
      this.metrics.currentEpochLiveValidators.set(
        newState.validators.filter((v) => isActiveValidator(v, currentEpoch)).length
      );
    }
    return newState;
  }

  private async updateDepositMerkleTree(newState: BeaconState): Promise<void> {
    const [deposits, merkleTree] = await Promise.all([
      this.db.deposit.getAll(),
      this.db.merkleTree.getProgressiveMerkleTree(
        this.config,
        newState.eth1DepositIndex
      )
    ]);
    processSortedDeposits(
      this.config,
      deposits,
      newState.eth1DepositIndex,
      newState.eth1Data.depositCount,
      (deposit, index) => {
        merkleTree.add(
          index + newState.eth1DepositIndex,
          hashTreeRoot(this.config.types.DepositData, deposit.data)
        );
        return deposit;
      }
    );
    //TODO: remove deposits with index <= newState.depositIndex
    await this.db.merkleTree.set(newState.eth1DepositIndex, merkleTree.toObject());
  }

  private checkGenesis = async (eth1Block: Block): Promise<void> => {
    this.logger.info(`Checking if block ${eth1Block.hash} will form valid genesis state`);
    const deposits = await this.opPool.deposits.getAll();
    const merkleTree = ProgressiveMerkleTree.empty(
      DEPOSIT_CONTRACT_TREE_DEPTH,
      new MerkleTreeSerialization(this.config)
    );
    const depositsWithProof = deposits
      .map((deposit, index) => {
        merkleTree.add(index, hashTreeRoot(this.config.types.DepositData, deposit.data));
        return deposit;
      })
      .map((deposit, index) => {
        deposit.proof = merkleTree.getProof(index);
        return deposit;
      });
    const genesisState = initializeBeaconStateFromEth1(
      this.config,
      Buffer.from(eth1Block.hash.replace("0x", ""), "hex"),
      eth1Block.timestamp,
      depositsWithProof
    );
    if(!isValidGenesisState(this.config, genesisState)) {
      this.logger.info(`Eth1 block ${eth1Block.hash} is NOT forming valid genesis state`);
      return;
    }
    this.logger.info(`Initializing beacon chain with eth1 block ${eth1Block.hash}`);
    await this.initializeBeaconChain(genesisState, merkleTree);
  };
}
