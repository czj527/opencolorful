// 兼容层：CJK n-gram 已抽为 storage/search 公共能力（Phase 11）。
// 新代码请直接 import "../../storage/search/cjk-ngram.js"。
export {
  normalizeSearchText,
  cjkNgrams,
  buildSearchText as buildMemorySearchText,
  buildFtsQuery as buildMemoryFtsQuery,
} from "../../storage/search/cjk-ngram.js";
export { hasCjk, isSingleCjkQuery, escapeLikePattern } from "../../storage/search/cjk-ngram.js";
