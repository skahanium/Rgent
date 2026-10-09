/** r11／r12 DeepSeek `v6-scope-01` 长期正文金标。来源是已冻结报告的终态条目，不读 `.cache`。 */
export const V6_SCOPE_01_STANDING = '仅石纹项目的评审材料要附成本表，不外推到别的项目。'
export const V6_SCOPE_01_FACT = '石纹项目已确认评审材料含成本表；这是该项目合同要求。'
export const V6_SCOPE_01_ROUNDS = [
 {label: 'r11-deepseek-r0', standing: V6_SCOPE_01_STANDING, fact: V6_SCOPE_01_FACT},
 {label: 'r12-deepseek-r0', standing: V6_SCOPE_01_STANDING, fact: V6_SCOPE_01_FACT},
 {label: 'r12-deepseek-r1', standing: V6_SCOPE_01_STANDING, fact: V6_SCOPE_01_FACT}
] as const
