import { supabase } from '../lib/supabase.js';
import { getUserTone, setUserTone, isToneAvailableForFree } from '../lib/tone-manager.js';

export default async function handler(req, res) {
  const { user_id } = req.method === 'POST' ? req.body : req.query;

  if (!user_id) {
    return res.status(400).json({ error: 'Missing user_id' });
  }

  try {
    // GET - Получить текущий стиль
    if (req.method === 'GET') {
      const tone = await getUserTone(user_id);
      
      return res.status(200).json({ 
        success: true,
        tone: tone
      });
    }

    // POST - Установить новый стиль
    if (req.method === 'POST') {
      const { tone } = req.body;

      if (!tone || !['focused', 'baddy', 'mentor'].includes(tone)) {
        return res.status(400).json({ 
          error: 'Invalid tone',
          message: 'Допустимые стили: focused, baddy, mentor'
        });
      }

      // Проверка Premium для Mentor
      if (tone === 'mentor') {
        const { data: subscription } = await supabase
          .from('subscriptions')
          .select('*')
          .eq('telegram_user_id', user_id)
          .eq('status', 'active')
          .maybeSingle();

        const isPremium = subscription && new Date(subscription.expires_at) > new Date();

        if (!isPremium) {
          return res.status(403).json({ 
            error: 'Premium required',
            message: 'Стиль Mentor доступен только в Premium',
            premium_required: true
          });
        }
      }

      // Сохранить выбор
      await setUserTone(user_id, tone);

      console.log(`✅ User ${user_id} changed tone to: ${tone}`);

      return res.status(200).json({ 
        success: true,
        tone: tone,
        message: 'Стиль успешно изменён'
      });
    }

    return res.status(405).json({ error: 'Method Not Allowed' });

  } catch (error) {
    console.error('❌ Tone API error:', error);
    return res.status(500).json({ 
      error: 'Internal error',
      message: 'Ошибка при смене стиля'
    });
  }
}
