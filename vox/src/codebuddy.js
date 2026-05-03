/**
 * @deprecated 旧名字保留兼容
 * 真实实现搬到 ./brain.js（支持任意 CLI：codebuddy / claude / claude-internal）
 */
export {
  callBrain as callCodeBuddy,
  callBrainJSON as callCodeBuddyJSON,
  extractJSON,
  resolveBrainBin,
  getBrainFlavor,
} from './brain.js';
