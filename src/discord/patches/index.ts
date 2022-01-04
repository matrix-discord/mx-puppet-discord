/* eslint-disable global-require */

// Patches loading order
export const Patches = [
  require('./APIMessage'),
];

console.log(`Applied ${Patches.length} patches.`);
