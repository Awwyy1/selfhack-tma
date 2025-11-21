import { createMissingSummaries } from '../lib/summarizer.js';

export default async function handler(req, res) {
  // CORS headers
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const { user_id } = req.body;

  if (!user_id) {
    return res.status(400).json({ error: 'user_id is required' });
  }

  try {
    console.log(`🔧 Fixing summaries for user ${user_id}`);
    await createMissingSummaries(user_id);
    return res.status(200).json({ success: true, message: 'Missing summaries created' });
  } catch (error) {
    console.error('Error fixing summaries:', error);
    return res.status(500).json({ error: 'Failed to fix summaries' });
  }
}
