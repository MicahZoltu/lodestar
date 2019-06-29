import {join} from "path";
import {describeSpecTest} from "@chainsafe/eth2.0-spec-test-util";
import {expect} from "chai";
// @ts-ignore
import {restore, rewire} from "@chainsafe/bls-js";
import sinon from "sinon";

import {processTransfer} from "../../../../src/chain/stateTransition/block/operations";
import {BeaconState, Transfer} from "../../../../src/types";
import {expandYamlValue} from "../../../utils/expandYamlValue";

describeSpecTest(
  join(__dirname, "../../test-cases/tests/operations/transfer/transfer_mainnet.yaml"),
  (state, transfer) => {
    processTransfer(state, transfer);
    return state;
  },
  (input) => {
    if(input.bls_setting && input.bls_setting.toNumber() === 2) {
      rewire({
        verify: sinon.stub().returns(true),
        verifyMultiple: sinon.stub().returns(true)
      });
    }
    return [expandYamlValue(input.pre, BeaconState), expandYamlValue(input.transfer, Transfer)];
  },
  (expected) => {
    return expandYamlValue(expected.post, BeaconState);
  },
  result => result,
  (testCase) => {
    return !testCase.post;
  },
  () => false,
  (_1, _2, expected, actual) => {
    //chai hates BN
    expected.balances = expected.balances.map(b => b.toString());
    actual.balances = actual.balances.map(b => b.toString());
    expect(expected).to.be.deep.equal(actual);
    restore();
  },
  0
);

