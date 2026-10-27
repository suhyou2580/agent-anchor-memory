// bundle 入口：只做再导出，保持插件逻辑在 src/ 下可被直接单测。
export { name, apply, default } from './src/dsh-plugin.js';
