import { execSync } from 'child_process';

function run() {
  const memStr = execSync('bd memories --json').toString();
  const mems = JSON.parse(memStr);

  const tokenRows = [];
  const estimates = {};

  for (const [key, val] of Object.entries(mems)) {
    if (typeof val === 'string' && val.includes('tokens: input=')) {
      tokenRows.push(key);
      
      const m = val.match(/^(?:([a-zA-Z0-9.\-+]+)\s+)?(?:(doer|reviewer|sprint-reviewer|review|code-review|integ-test-runner|final-reviewer|sprint-tasks|streak-ceiling-test|skill-pm-roles-test)\s+)?([a-zA-Z0-9.-]+)\s+tokens:\s+input=~?(\d+)\s+output=~?(\d+)/i);
      
      if (m) {
        let [, label, role, model, inTok, outTok] = m;
        role = role || 'doer';
        const inT = parseInt(inTok, 10);
        const outT = parseInt(outTok, 10);
        const size = 'M';
        
        const estKey = `${model}|${size}|${role}`;
        if (!estimates[estKey]) {
          estimates[estKey] = { model, task_size: size, role, total_input: 0, total_output: 0, count: 0 };
        }
        estimates[estKey].total_input += inT;
        estimates[estKey].total_output += outT;
        estimates[estKey].count += 1;
      } else {
        // Fallback generic parse for other formats
        const mFallback = val.match(/([a-zA-Z0-9.-]+)\s+tokens:\s+input=~?(\d+)\s+output=~?(\d+)/i);
        if (mFallback) {
          const [, model, inTok, outTok] = mFallback;
          const role = 'doer';
          const size = 'M';
          const inT = parseInt(inTok, 10);
          const outT = parseInt(outTok, 10);
          const estKey = `${model}|${size}|${role}`;
          if (!estimates[estKey]) {
            estimates[estKey] = { model, task_size: size, role, total_input: 0, total_output: 0, count: 0 };
          }
          estimates[estKey].total_input += inT;
          estimates[estKey].total_output += outT;
          estimates[estKey].count += 1;
        }
      }
    }
  }

  const finalEstimates = [];
  for (const stat of Object.values(estimates)) {
    finalEstimates.push({
      model: stat.model,
      task_size: stat.task_size,
      role: stat.role,
      avg_input_toks: Math.round(stat.total_input / stat.count).toString(),
      avg_output_toks: Math.round(stat.total_output / stat.count).toString()
    });
  }

  // Remove old
  for (const key of tokenRows) {
    try {
      execSync(`bd forget "${key}"`, { stdio: 'ignore' });
    } catch (e) {
      console.log(`Failed to forget memory: ${key}`);
    }
  }

  // Save new
  if (finalEstimates.length > 0) {
    execSync(`bd remember "token estimates: ${JSON.stringify(finalEstimates).replace(/"/g, '\\"')}"`);
  }
  
  console.log(`Removed ${tokenRows.length} transactions, saved ${finalEstimates.length} averages.`);
}

run();
