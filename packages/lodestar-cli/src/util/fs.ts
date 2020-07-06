import fs from "fs";

/**
 * Create a file with `600 (-rw-------)` permissions
 * *Note*: 600: Owner has full read and write access to the file,
 * while no other user can access the file
 */
export function writeFile600Perm(filepath: string, data: string): void {
  fs.writeFileSync(filepath, data);
  fs.chmodSync(filepath, "0600");
}
