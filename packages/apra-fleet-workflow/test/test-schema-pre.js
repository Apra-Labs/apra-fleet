export const meta = { name: 'test-schema-pre' };

export async function main(context) {
    const { agent, phase } = context;

    phase('Test Invalid Schema Pre-condition');
    
    // Provide a structurally invalid JSON schema to trigger Ajv compile error
    await agent('This should fail before hitting the LLM', {
        member_name: 'apra-pm',
        schema: {
            type: "invalid_type_name_that_ajv_hates"
        }
    });

    return { status: 'success' };
}
