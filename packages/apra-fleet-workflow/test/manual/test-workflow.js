export const meta = {
  name: 'hello-world-workflow',
  description: 'A sample workflow testing the fleet-workflow engine',
  phases: [{ title: 'Init', detail: 'Say hello' }, { title: 'Process', detail: 'Do work concurrently' }]
};

async function main() {
  log("Starting the workflow execution...");
  
  phase('Init');
  const response = await agent('Say a nice short greeting', { 
    member_name: 'apra-pm', 
    model: 'cheap' 
  });
  log(`Greeting received: ${response}`);

  phase('Process');
  // Demonstrate parallel execution
  log("Running 3 parallel background tasks...");
  const results = await parallel([
    async () => agent('Count to 3', { member_name: 'fleet-dev' }),
    async () => { throw new Error('Simulated failure in parallel thunk'); },
    async () => agent('Say the word "banana"', { member_name: 'apra-pm' })
  ]);
  
  log(`Parallel array returned: ${JSON.stringify(results)}`);
  
  log("Running Sequential on items [1, 2]");
  const processed = await sequential(
      [1, 2],
      async (item) => { log(`Sequential stage 1 for ${item}`); return item + 10; },
      async (item) => { log(`Sequential stage 2 for ${item}`); return item * 2; }
  );
  
  log(`Sequential returned: ${JSON.stringify(processed)}`);
  
  log(`Passed args were: ${JSON.stringify(args)}`);
  return { status: 'success', name: meta.name };
}
