import { prepareEvaluationCorpus } from "../src/corpus/evaluation-author"
const args = process.argv.slice(2)
if (args.length !== 4 || args[0] !== "--source-root" || args[2] !== "--output-root")
  throw new TypeError("Expected --source-root <fixed D tasks> --output-root <new owned directory>")
const report = await prepareEvaluationCorpus({ sourceRoot: args[1]!, outputRoot: args[3]! })
// Never print hidden material or attempt to activate a campaign.
console.log(JSON.stringify(report))
