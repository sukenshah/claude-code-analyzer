import { analyze } from "./index.js";

const result = await analyze(true);

console.log(`\n=== Claude Code Usage Analysis ===`);
console.log(`Projects:  ${result.summary.projectCount}`);
console.log(`Sessions:  ${result.summary.sessionCount}`);
console.log(`Turns:     ${result.summary.turnCount}`);
console.log(`New files: ${result.newFilesScanned}`);
console.log(`\nTotal cost: $${result.summary.totalCost.toFixed(4)}`);
console.log(`Tokens: in=${result.summary.totals.input_tokens.toLocaleString()} out=${result.summary.totals.output_tokens.toLocaleString()} cache_read=${result.summary.totals.cache_read_input_tokens.toLocaleString()} cache_write=${result.summary.totals.cache_creation_input_tokens.toLocaleString()}`);

console.log(`\nBy model:`);
for (const [model, stats] of Object.entries(result.summary.byModel)) {
  console.log(`  ${model}: $${stats.cost.toFixed(4)} (${stats.usage.input_tokens + stats.usage.output_tokens} tokens)`);
}

console.log(`\nProjects:`);
for (const [, project] of result.projects) {
  console.log(`  ${project.projectName}: ${project.sessionCount} sessions, $${project.totalCost.toFixed(4)}`);
}
