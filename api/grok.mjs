const GROQ_MODEL = process.env.GROQ_MODEL || 'openai/gpt-oss-20b';
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
        headers: {
            'Content-Type': 'application/json'
        },
        ...init
    });
}

function parseGrokJsonResponse(rawContent = '') {
    let cleanContent = rawContent.trim();

    if (cleanContent.startsWith('```json')) {
        cleanContent = cleanContent.replace(/^```json/, '').replace(/```$/, '').trim();
    } else if (cleanContent.startsWith('```')) {
        cleanContent = cleanContent.replace(/^```/, '').replace(/```$/, '').trim();
    }

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
You MUST respond ONLY with a raw JSON object that matches the required schema. Do NOT wrap the response in markdown blocks (e.g., \`\`\`json).
Do not include any introductory or concluding text.

Generate a setlist based on the user's prompt.
Return an object with a single "songs" array.
Each song object must include:
- title
- artist
- youtubeId
- chords

If you are not confident about a YouTube video ID, use null.
'chords' should be standard chord chart format utilizing line breaks.`;

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
    const youtubeUrl = String(payload.youtubeUrl || '').trim();
    const originalKey = normalizeSongKey(payload.originalKey);
    const transposeTo = normalizeSongKey(payload.transposeTo || payload.originalKey);

    const systemPrompt = `You are WorshipFlow AI, a precise JSON generator for manual worship song entry.
You MUST respond ONLY with a raw JSON object that matches the required schema. Do NOT wrap the response in markdown blocks (e.g., \`\`\`json).
Do not include any introductory or concluding text.

Return exactly this structure:
{
    "title": "Song Title",
    "artist": "Artist Name",
    "originalKey": "C",
    "transposeTo": "C",
    "notes": "Short optional performance note. Empty string if none.",
    "chords": "Verse 1\\n[C]Lyrics line\\n[G]Next line"
}

Rules:
- Never return null values.
- For key fields, use only one of these values: C, C#/Db, D, D#/Eb, E, F, F#/Gb, G, G#/Ab, A, A#/Bb, B.
- The chords field must be a usable draft in [Chord] format with section labels like Verse, Chorus, and Bridge.
- Make the best possible worship-song draft using the provided title, artist, and YouTube URL.
- If exact lyrics or chords are uncertain, still provide a clean best-effort draft without apologies or disclaimers inside the JSON.`;

    const userPrompt = `Create a manual worship song draft for this request.
Title: ${title || 'Not provided'}
Artist: ${artist || 'Not provided'}
YouTube URL: ${youtubeUrl || 'Not provided'}
Selected Original Key: ${originalKey}
Selected Transpose Key: ${transposeTo}

Priorities:
1. Fill in a likely title and artist when possible.
2. Suggest a likely original key.
3. Return a useful lyrics-and-chords draft for quick manual editing.
4. Keep notes short and optional.`;

    return { systemPrompt, userPrompt };
}

async function callGroq(systemPrompt, userPrompt, schemaName, schema) {
    const apiKey = process.env.GROQ_API_KEY;

    if (!apiKey) {
        throw new Error('GROQ_API_KEY is not configured on the server.');
    }

    const response = await fetch('https://api.groq.com/openai/v1/chat/completions', {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${apiKey}`
        },
        body: JSON.stringify({
            model: GROQ_MODEL,
            messages: [
                { role: 'system', content: systemPrompt },
                { role: 'user', content: userPrompt }
            ],
            temperature: 0.2,
            response_format: {
                type: 'json_schema',
                json_schema: {
                    name: schemaName,
                    strict: true,
                    schema
                }
            }
        })
    });

    if (!response.ok) {
        const errorText = await response.text();
        let detail = errorText;

        try {
            const parsed = JSON.parse(errorText);
            detail =
                parsed.error?.message ||
                parsed.message ||
                parsed.error ||
                errorText;
        } catch (error) {
            detail = errorText;
        }

        throw new Error(`Groq API returned status ${response.status}: ${detail}`);
    }

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
            const result = await callGroq(
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
            const draft = await callGroq(
                systemPrompt,
                userPrompt,
                'worship_song_draft_response',
                SONG_DRAFT_SCHEMA
            );

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
