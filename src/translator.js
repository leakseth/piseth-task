import dotenv from 'dotenv';

dotenv.config();

/**
 * Free Google Translate Web API endpoint fallback
 * Works out-of-the-box with NO API key needed.
 */
async function translateWithGoogleFree(text, fromLang, toLang) {
  const url = `https://translate.googleapis.com/translate_a/single?client=gtx&sl=${fromLang}&tl=${toLang}&dt=t&q=${encodeURIComponent(text)}`;

  const response = await fetch(url, {
    headers: {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    },
  });

  if (!response.ok) {
    throw new Error(`Google Translate responded with status: ${response.status}`);
  }

  const data = await response.json();
  if (!data || !data[0] || !Array.isArray(data[0])) {
    throw new Error('Unexpected translation response format from Google');
  }

  return data[0].map((chunk) => chunk[0]).join('');
}

// Cached working model name to avoid repeating discovery
let cachedModelPath = null;

/**
 * Dynamically discover the best available Gemini model for the user's API key.
 * Prioritizes high-rate-limit free tier models (Flash) before Pro models.
 */
async function getWorkingGeminiModel(apiKey) {
  if (cachedModelPath) return cachedModelPath;

  // 1. If user explicitly specified GEMINI_MODEL in .env, prioritize it
  if (process.env.GEMINI_MODEL) {
    const raw = process.env.GEMINI_MODEL.trim().replace(/^models\//, '');
    return `v1beta/models/${raw}`;
  }

  // 2. Query the official models list for this specific API key
  try {
    const listUrl = `https://generativelanguage.googleapis.com/v1beta/models?key=${apiKey}`;
    const listRes = await fetch(listUrl, {
      headers: {
        'x-goog-api-key': apiKey,
      },
    });

    if (listRes.ok) {
      const data = await listRes.json();
      const models = data.models || [];

      // Filter for models that support generateContent
      const generativeModels = models.filter((m) =>
        m.supportedGenerationMethods?.includes('generateContent')
      );

      // Priority list of flash models (15 RPM / free quota on Google AI Studio)
      const flashModels = generativeModels.filter((m) =>
        m.name && m.name.toLowerCase().includes('flash')
      );

      if (flashModels.length > 0) {
        // Prefer modern 2.5-flash, flash-latest, flash-lite
        const bestFlash =
          flashModels.find((m) => m.name.includes('2.5-flash')) ||
          flashModels.find((m) => m.name.includes('flash-latest')) ||
          flashModels.find((m) => m.name.includes('flash-lite')) ||
          flashModels.find((m) => m.name.includes('2.0-flash')) ||
          flashModels[0];

        const modelName = bestFlash.name.replace(/^models\//, '');
        console.log(`🤖 Auto-detected active Gemini Flash model: ${modelName}`);
        return `v1beta/models/${modelName}`;
      }

      if (generativeModels.length > 0) {
        const modelName = generativeModels[0].name.replace(/^models\//, '');
        console.log(`🤖 Auto-detected available Gemini model: ${modelName}`);
        return `v1beta/models/${modelName}`;
      }
    } else {
      console.warn(`⚠️ Google models.list returned HTTP ${listRes.status}`);
    }
  } catch (err) {
    console.warn('⚠️ Could not auto-list Gemini models, using default fallbacks:', err.message);
  }

  // 3. Modern default fallback
  return 'v1beta/models/gemini-2.5-flash';
}

/**
 * Call Google Gemini API with smart model auto-detection and fallback
 * Handles 404 (Not Found / Deprecated) and 429 (Quota exceeded / Pro model limit 0 on free tier)
 */
async function callGemini(prompt) {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    throw new Error('GEMINI_API_KEY_MISSING');
  }

  // Dynamically detected model
  const detectedModel = await getWorkingGeminiModel(apiKey);

  // Modern models list: Modern Flash models (Free tier friendly) -> Pro models -> Fallbacks
  const candidateModels = [
    // 1. User explicit GEMINI_MODEL
    process.env.GEMINI_MODEL ? `v1beta/models/${process.env.GEMINI_MODEL.trim().replace(/^models\//, '')}` : null,
    // 2. Previously cached working model
    cachedModelPath,
    // 3. Dynamically detected model
    detectedModel,
    // 4. Modern Flash generation (100% free with 15 RPM on Google AI Studio)
    'v1beta/models/gemini-2.5-flash',
    'v1beta/models/gemini-2.5-flash-lite',
    'v1beta/models/gemini-flash-latest',
    'v1beta/models/gemini-3.1-flash-lite',
    'v1beta/models/gemini-2.0-flash',
    // 5. Pro models (require quota / billing on Google Cloud)
    'v1beta/models/gemini-2.5-pro',
    'v1beta/models/gemini-3.1-pro',
    'v1beta/models/gemini-pro-latest',
    // 6. Legacy fallbacks
    'v1beta/models/gemini-1.5-flash',
    'v1beta/models/gemini-1.5-flash-latest',
    'v1beta/models/gemini-1.5-pro',
  ];

  // Remove duplicates and falsy entries
  const uniqueModels = [...new Set(candidateModels.filter(Boolean))];

  let lastError = null;

  for (const modelPath of uniqueModels) {
    try {
      const url = `https://generativelanguage.googleapis.com/${modelPath}:generateContent?key=${apiKey}`;

      const response = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-goog-api-key': apiKey,
        },
        body: JSON.stringify({
          contents: [{ parts: [{ text: prompt }] }],
          generationConfig: {
            temperature: 0.2,
          },
        }),
      });

      if (response.ok) {
        const result = await response.json();
        const text = result.candidates?.[0]?.content?.parts?.[0]?.text;
        if (text) {
          cachedModelPath = modelPath; // Remember the winning model!
          return text.trim();
        }
      } else {
        const errorText = await response.text();
        let parsedMessage = errorText;
        try {
          const parsed = JSON.parse(errorText);
          parsedMessage = parsed.error?.message || errorText;
        } catch (_) {}

        lastError = new Error(`Gemini API [${modelPath}] (${response.status}): ${parsedMessage}`);

        // If 404 (model name not found/deprecated) OR 429 (quota exceeded / limit: 0 on Pro models), try next model!
        if (response.status === 404 || response.status === 429) {
          console.warn(`⚠️ [${modelPath}] returned HTTP ${response.status} (limit 0 or not found). Auto-switching to next model...`);
          continue;
        }

        throw lastError;
      }
    } catch (err) {
      lastError = err;
      if (err.message && (err.message.includes('404') || err.message.includes('429'))) {
        continue;
      }
      throw err;
    }
  }

  throw lastError || new Error('All Gemini model endpoints returned error');
}

/**
 * Optional OpenAI API fallback if OPENAI_API_KEY is configured
 */
async function callOpenAI(prompt) {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    throw new Error('OPENAI_API_KEY_MISSING');
  }

  const response = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model: 'gpt-4o-mini',
      messages: [{ role: 'user', content: prompt }],
      temperature: 0.2,
    }),
  });

  if (!response.ok) {
    const err = await response.text();
    throw new Error(`OpenAI API error (${response.status}): ${err}`);
  }

  const result = await response.json();
  return result.choices?.[0]?.message?.content?.trim() || '';
}

/**
 * Check which AI provider is configured
 */
export function getActiveAiProvider() {
  if (process.env.GEMINI_API_KEY) return 'Google Gemini AI';
  if (process.env.OPENAI_API_KEY) return 'OpenAI';
  return 'Google Translate (Free)';
}

/**
 * 1. Translate Khmer to English
 */
export async function translateKhmerToEnglish(text) {
  if (process.env.GEMINI_API_KEY) {
    try {
      const prompt = 
`You are an expert translator specializing in Khmer (ភាសាខ្មែរ) and English.
Translate the following Khmer text accurately and naturally into English.
Provide ONLY the translated English text without quotes, introductory text, or commentary.

Khmer text:
${text}`;

      const translated = await callGemini(prompt);
      return { text: translated, provider: 'Google Gemini' };
    } catch (err) {
      console.warn('⚠️ Gemini translation failed, falling back to Google Translate:', err.message);
    }
  }

  if (process.env.OPENAI_API_KEY) {
    try {
      const prompt = `Translate this Khmer text to natural English. Output only the translated English:\n\n${text}`;
      const translated = await callOpenAI(prompt);
      return { text: translated, provider: 'OpenAI' };
    } catch (err) {
      console.warn('⚠️ OpenAI translation failed, falling back to Google Translate:', err.message);
    }
  }

  const fallback = await translateWithGoogleFree(text, 'km', 'en');
  return { text: fallback, provider: 'Google Translate' };
}

/**
 * 2. Translate English to Khmer
 */
export async function translateEnglishToKhmer(text) {
  if (process.env.GEMINI_API_KEY) {
    try {
      const prompt = 
`You are an expert translator specializing in English and Khmer (ភាសាខ្មែរ).
Translate the following English text accurately and naturally into Khmer.
Provide ONLY the translated Khmer text without quotes, introductory text, or commentary.

English text:
${text}`;

      const translated = await callGemini(prompt);
      return { text: translated, provider: 'Google Gemini' };
    } catch (err) {
      console.warn('⚠️ Gemini translation failed, falling back to Google Translate:', err.message);
    }
  }

  if (process.env.OPENAI_API_KEY) {
    try {
      const prompt = `Translate this English text to natural Khmer (ភាសាខ្មែរ). Output only the translated Khmer:\n\n${text}`;
      const translated = await callOpenAI(prompt);
      return { text: translated, provider: 'OpenAI' };
    } catch (err) {
      console.warn('⚠️ OpenAI translation failed, falling back to Google Translate:', err.message);
    }
  }

  const fallback = await translateWithGoogleFree(text, 'en', 'km');
  return { text: fallback, provider: 'Google Translate' };
}

/**
 * 3. Fix English Grammar and provide explanations
 */
export async function fixEnglishGrammar(text) {
  const hasAiKey = Boolean(process.env.GEMINI_API_KEY || process.env.OPENAI_API_KEY);

  if (!hasAiKey) {
    return {
      hasKey: false,
      corrected: '',
      explanation: '',
      provider: 'None',
    };
  }

  const prompt = 
`You are an expert English grammar teacher and proofreader.
Carefully analyze this sentence:
"${text}"

Check for grammatical mistakes, spelling, punctuation, preposition usage, verb tense agreement, and natural phrasing.

Format your response in EXACTLY this structure:
[CORRECTED]
<Write the corrected, natural English sentence here. If it was already 100% correct, write it cleanly.>

[EXPLANATION]
<Provide 2-4 concise, clear bullet points explaining what was wrong, why the change was made, or confirming why the sentence was already correct. Write explanations in clear, friendly English with simple words.>`;

  let raw = '';
  let provider = 'Gemini AI';

  if (process.env.GEMINI_API_KEY) {
    raw = await callGemini(prompt);
  } else if (process.env.OPENAI_API_KEY) {
    raw = await callOpenAI(prompt);
    provider = 'OpenAI';
  }

  let corrected = '';
  let explanation = '';

  if (raw.includes('[CORRECTED]') && raw.includes('[EXPLANATION]')) {
    const parts = raw.split('[EXPLANATION]');
    corrected = parts[0].replace('[CORRECTED]', '').trim();
    explanation = parts[1].trim();
  } else {
    corrected = raw.trim();
    explanation = 'Grammar and sentence phrasing refined for clarity.';
  }

  return {
    hasKey: true,
    corrected,
    explanation,
    provider,
  };
}
