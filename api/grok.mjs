const GROQ_MODEL_COMPOUND = 'groq/compound'; // Built-in tool model for web searching
const GROQ_MODEL_STANDARD = process.env.GROQ_MODEL || 'openai/gpt-oss-20b'; // Fast model for setlists
const VALID_SONG_KEYS = ['C', 'C#/Db', 'D', 'D#/Eb', 'E', 'F', 'F#/Gb', 'G', 'G#/Ab', 'A', 'A#/Bb', 'B'];

const SETLIST_RESPONSE_SCHEMA = {
    type: 'object',
    additionalProperties: false,
    properties: {
        songs: {
            type: 'array',
            items: {
                type: 'object',
                additionalProperties: false,
                properties: {
                    title: { type: 'string' },
                    artist: { type: 'string' },
                    youtubeId: { type: ['string', 'null'] },
                    chords: { type: 'string' }
                },
                required: ['title', 'artist', 'youtubeId', 'chords']
            }
        }
    },
    required: ['songs']
};

const SONG_DRAFT_SCHEMA = {
    type: 'object',
    additionalProperties: false,
    properties: {
        title: { type: 'string' },
        artist: { type: 'string' },
        originalKey: { type: 'string' },
        transposeTo: { type: 'string' },
        notes: { type: 'string' },
        chords: { type: 'string' }
    },
    required: ['title', 'artist', 'originalKey', 'transposeTo', 'notes', 'chords']
};

function json(data, init = {}) {
    return new Response(JSON.stringify(data), {
        headers: { 'Content-Type': 'application/json' },
        ...init
    });
}

function parseGrokJsonResponse(rawContent = '') {
    let cleanContent = rawContent.trim();
    if (cleanContent.startsWith('```json')) cleanContent = cleanContent.replace(/^```json/, '').replace(/```$/, '').trim();
    else if (cleanContent.startsWith('```')) cleanContent = cleanContent.replace(/^```/, '').replace(/```$/, '').trim();
    return JSON.parse(cleanContent);
}

function normalizeSongKey(value = '') {
    const key = String(value).trim();
    return VALID_SONG_KEYS.includes(key) ? key : 'C';
}

function buildSetlistPrompts(payload = {}) {
    const theme = String(payload.theme || '').trim();
    const occasion = String(payload.occasion || '').trim();
    const notes = String(payload.notes || '').trim();
    const specificSongs = Array.isArray(payload.specificSongs) ? payload.specificSongs : [];

    const systemPrompt = `You are WorshipFlow AI, a precise JSON generator for worship setlists.
You MUST respond ONLY with a raw JSON object that matches the required schema. Do NOT wrap the response in markdown blocks.
Generate a setlist based on the user's prompt.`;

    let userPrompt = 'Create a worship setlist. ';
    if (theme) userPrompt += `Theme: ${theme}. `;
    if (occasion) userPrompt += `Occasion: ${occasion}. `;
    if (specificSongs.length > 0) {
        userPrompt += 'MUST include these specific songs: ';
        specificSongs.forEach((song) => {
            const title = String(song.title || '').trim();
            const url = String(song.url || '').trim();
            userPrompt += `"${title}" ${url ? `(YouTube: ${url})` : ''}, `;
        });
    }
    if (notes) userPrompt += `Additional notes: ${notes}. `;

    return { systemPrompt, userPrompt };
}

function buildSongDraftPrompts(payload = {}) {
    const title = String(payload.title || '').trim();
    const artist = String(payload.artist || '').trim();
    const originalKey = normalizeSongKey(payload.originalKey);
    const transposeTo = normalizeSongKey(payload.transposeTo || payload.originalKey);

    const systemPrompt = `You are WorshipFlow AI. Your primary goal is to find the EXACT lyrics and chords for songs.
1. Use your built-in 'web_search' to find the song on ultimate-guitar.com.
2. Use 'visit_website' to read the full page if necessary.
3. Extract the exact lyrics and chords. Format the chords in [ChordName] format (e.g. [C], [Am]).
4. You MUST respond ONLY with a raw JSON object matching the required schema. Do NOT wrap the response in markdown blocks.`;

    const userPrompt = `Find exact lyrics and chords from ultimate-guitar.com for the song: "${title || 'Unknown Title'}" by ${artist || 'Unknown Artist'}. 
    Original Key: ${originalKey}
    Transpose Key: ${transposeTo}
    Format the final output strictly as JSON.`;

    return { systemPrompt, userPrompt };
}

// Standard call for Setlists (No tools, fast response)
async function callGroqStandard(systemPrompt, userPrompt, schemaName, schema) {
    const apiKey = process.env.GROQ_API_KEY;
    if (!apiKey) throw new Error('GROQ_API_KEY is not configured on the server.');

    const response = await fetch('https://api.groq.com/openai/v1/chat/completions', {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${apiKey}`
        },
        body: JSON.stringify({
            model: GROQ_MODEL_STANDARD,
            messages: [
                { role: 'system', content: systemPrompt },
                { role: 'user', content: userPrompt }
            ],
            temperature: 0.2,
            response_format: { type: 'json_schema', json_schema: { name: schemaName, strict: true, schema } }
        })
    });

    if (!response.ok) throw new Error(`Groq API Error: ${await response.text()}`);
    const data = await response.json();
    return parseGrokJsonResponse(data.choices?.[0]?.message?.content || '');
}

// Compound call for Song Drafts (Uses Groq's built-in web search & browsing)
async function callGroqAgent(systemPrompt, userPrompt) {
    const apiKey = process.env.GROQ_API_KEY;
    if (!apiKey) throw new Error('GROQ_API_KEY is not configured on the server.');

    const response = await fetch('https://api.groq.com/openai/v1/chat/completions', {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${apiKey}`
        },
        body: JSON.stringify({
            model: GROQ_MODEL_COMPOUND,
            messages: [
                { role: 'system', content: systemPrompt },
                { role: 'user', content: userPrompt }
            ],
            temperature: 0.1,
            // Enable Groq's internal built-in tools
            compound_custom: {
                tools: {
                    enabled_tools: ["web_search", "visit_website"]
                }
            },
            // Ask for JSON object mode so the scraped data fits your UI exactly
            response_format: { type: 'json_object' }
        })
    });

    if (!response.ok) throw new Error(`Groq API Error: ${await response.text()}`);
    const data = await response.json();
    return parseGrokJsonResponse(data.choices?.[0]?.message?.content || '');
}

export async function POST(request) {
    try {
        const body = await request.json();
        const action = String(body.action || '');
        const payload = body.payload || {};

        if (!action) {
            return json({ error: 'Missing action.' }, { status: 400 });
        }

        if (action === 'generate-setlist') {
            const { systemPrompt, userPrompt } = buildSetlistPrompts(payload);
            const result = await callGroqStandard(
                systemPrompt,
                userPrompt,
                'worship_setlist_response',
                SETLIST_RESPONSE_SCHEMA
            );
            const songs = result?.songs;

            if (!Array.isArray(songs)) {
                return json({ error: 'Groq returned an invalid setlist format.' }, { status: 502 });
            }

            return json({ songs });
        }

        if (action === 'draft-song') {
            const { systemPrompt, userPrompt } = buildSongDraftPrompts(payload);
            const draft = await callGroqAgent(systemPrompt, userPrompt);

            // Basic validation to ensure it didn't just return a blank string
            if (!draft || Array.isArray(draft) || typeof draft !== 'object') {
                return json({ error: 'Groq returned an invalid song draft format.' }, { status: 502 });
            }

            return json({ draft });
        }

        return json({ error: 'Unsupported action.' }, { status: 400 });
    } catch (error) {
        return json(
            { error: error instanceof Error ? error.message : 'Unexpected server error.' },
            { status: 500 }
        );
    }
}