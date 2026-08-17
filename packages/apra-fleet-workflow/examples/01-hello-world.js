export const meta = { 
    name: 'hello-world', 
    description: 'A simple hello world workflow demonstrating agent and command primitives' 
};

export async function main(context) {
    const { agent, command, log, phase } = context;

    phase('Hello World Setup');
    log('Starting the hello world workflow...');
    
    // Command example
    const cmdResult = await command('echo "Hello World from shell!"', {
        member_name: 'apra-pm'
    });
    log(`Command Output: ${cmdResult}`);
    
    phase('Agent Interaction');
    const agentResult = await agent('Say hello world and provide a short greeting.', {
        member_name: 'apra-pm',
        schema: {
            type: "object",
            properties: {
                greeting: { type: "string" },
                message: { type: "string" }
            },
            required: ["greeting", "message"]
        }
    });
    
    log(`Agent Response: ${JSON.stringify(agentResult, null, 2)}`);

    phase('Email Notification');
    log('Attempting email send (skips if not configured)...');

    try {
      const emailResult = await agent(
        'Send a test email using send_email with provider "sendgrid", ' +
        'from "hello@example.com", to "team@example.com", ' +
        'subject "Hello from workflow", body "Test email from hello-world workflow". ' +
        'If send_email fails because the credential store has no sendgrid_api_key, ' +
        'report the error.',
        {
          member_name: 'apra-pm',
          schema: {
            type: "object",
            properties: {
              ok: { type: "boolean" },
              detail: { type: "string" }
            },
            required: ["ok", "detail"]
          }
        }
      );
      log(`Email phase: ${JSON.stringify(emailResult)}`);
    } catch (err) {
      log(`[SKIP] email phase: ${err.message}`);
    }

    return { status: 'success', data: agentResult };
}
