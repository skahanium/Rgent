/** 人删除入口只在 macOS。Windows 未证明前不出现入口；原生层报 PLATFORM_UNPROVEN。 */
export const HUMAN_TRASH_ON_THIS_PLATFORM = process.platform === 'darwin'
