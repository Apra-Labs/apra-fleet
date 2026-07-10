export const MODEL_PRICING = {
    // Standard models (price per 1M tokens)
    'gpt-4o': { prompt: 5.00, completion: 15.00 },
    'gpt-4-turbo': { prompt: 10.00, completion: 30.00 },
    'claude-3-5-sonnet-20240620': { prompt: 3.00, completion: 15.00 },
    'claude-3-opus-20240229': { prompt: 15.00, completion: 75.00 },
    'gemini-1.5-pro': { prompt: 3.50, completion: 10.50 },
    'gemini-1.5-flash': { prompt: 0.35, completion: 1.05 },
    // Default fallback if unknown (average cost)
    'default': { prompt: 5.00, completion: 15.00 }
};

export function calculateCost(modelName, usage) {
    if (!usage || (!usage.prompt_tokens && !usage.completion_tokens)) return 0;
    
    // Normalize model name
    let pricing = MODEL_PRICING['default'];
    if (modelName) {
        const key = Object.keys(MODEL_PRICING).find(k => modelName.toLowerCase().includes(k));
        if (key) pricing = MODEL_PRICING[key];
    }
    
    const pTokens = usage.prompt_tokens || 0;
    const cTokens = usage.completion_tokens || 0;
    
    const promptCost = (pTokens / 1000000) * pricing.prompt;
    const compCost = (cTokens / 1000000) * pricing.completion;
    
    return promptCost + compCost;
}
