// commit-and-tag-version "updater" for the generated SSOT (src/version.ts).
//
// Registering src/version.ts as a bumpFile (see .versionrc.json) is what makes
// the release tool rewrite AND commit it atomically with package.json. The
// alternative — a postbump `git add` — does NOT work: commit-and-tag-version
// commits with an explicit pathspec, so a separately-staged file is silently
// left out of the tagged release commit.
//
// Must be CommonJS (.cjs): commit-and-tag-version require()s it, and this package
// is type:module. The regex matches the canonical line genversion.mjs emits.
const RE = /export const VERSION = "([^"]+)";/;

module.exports.readVersion = function readVersion(contents) {
  const match = contents.match(RE);
  return match ? match[1] : undefined;
};

module.exports.writeVersion = function writeVersion(contents, version) {
  return contents.replace(RE, `export const VERSION = "${version}";`);
};
