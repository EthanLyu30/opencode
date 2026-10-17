import { prepareEvaluationCorpus } from "../src/corpus/evaluation-author"
import { verifyPreparedCorpus } from "../src/corpus/evaluation-authoring"
const args = process.argv.slice(2)
if (args.length === 2 && args[0] === "--verify-root") {
  console.log(JSON.stringify(await verifyPreparedCorpus({ root: args[1]! })))
  process.exit(0)
}
if (
  ![4, 6].includes(args.length) ||
  args[0] !== "--source-root" ||
  args[2] !== "--output-root" ||
  (args.length === 6 && args[4] !== "--authoring-root")
)
  throw new TypeError(
    "Expected --source-root <fixed D tasks> --output-root <new owned directory> [--authoring-root <owned private authoring>]",
  )
const report = await prepareEvaluationCorpus({
  sourceRoot: args[1]!,
  outputRoot: args[3]!,
  ...(args[5] ? { authoringRoot: args[5] } : {}),
})
// Never print hidden material or attempt to activate a campaign.
console.log(JSON.stringify(report))
