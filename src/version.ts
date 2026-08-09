/**
 * Kept here rather than read from package.json: importing JSON needs either an
 * import attribute (whose syntax has changed twice) or a filesystem read from a
 * path that depends on how the package was bundled. A constant cannot fail at
 * runtime. RELEASING.md pins it to the version in package.json.
 */
export const VERSION = '0.3.1';
