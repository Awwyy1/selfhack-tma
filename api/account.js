import { supabase } from '../lib/supabase.js';

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const { action, user_id } = req.body;

  if (!action || !user_id) {
    return res.status(400).json({ error: 'Missing action or user_id' });
  }

  // ========== SET TONE ==========
  if (action === 'set-tone') {
    const { tone } = req.body;
    
    if (!tone) {
      return res.status(400).json({ error: 'Missing tone' });
    }

    const validTones = ['focused', 'baddy', 'mentor'];
    if (!validTones.includes(tone)) {
      return res.status(400).json({ error: 'Invalid tone' });
    }

    try {
      const { error } = await supabase
        .from('user_preferences')
        .upsert({
          telegram_user_id: user_id,
          tone: tone,
          updated_at: new Date().toISOString()
        }, {
          onConflict: 'telegram_user_id'
        });

      if (error) throw error;

      console.log(`Tone updated for user ${user_id}: ${tone}`);
      
      return res.status(200).json({ 
        success: true, 
        tone: tone 
      });
    } catch (error) {
      console.error('Set tone error:', error);
      return res.status(500).json({ error: 'Failed to update tone' });
    }
  }

  // ========== APPLY PROMO ==========
  if (action === 'apply-promo') {
    const { code } = req.body;

    if (!code) {
      return res.status(400).json({ success: false, message: 'Введите промокод' });
    }

    try {
      // Найти промокод
      const { data: promo, error: promoError } = await supabase
        .from('promo_codes')
        .select('*')
        .eq('code', code.toUpperCase())
        .eq('is_active', true)
        .maybeSingle();

      if (promoError) throw promoError;

      if (!promo) {
        return res.status(400).json({ success: false, message: 'Промокод не найден или неактивен' });
      }

      // Проверить лимит использований
      if (promo.max_uses && promo.used_count >= promo.max_uses) {
        return res.status(400).json({ success: false, message: 'Промокод больше не действителен' });
      }

      // Проверить срок действия
      if (promo.expires_at && new Date(promo.expires_at) < new Date()) {
        return res.status(400).json({ success: false, message: 'Срок действия промокода истёк' });
      }

      // Проверить не использовал ли уже этот пользователь
      const { data: existingUse } = await supabase
        .from('promo_uses')
        .select('id')
        .eq('promo_code_id', promo.id)
        .eq('telegram_user_id', user_id)
        .maybeSingle();

      if (existingUse) {
        return res.status(400).json({ success: false, message: 'Ты уже использовал этот промокод' });
      }

      // Вычислить дату окончания подписки
      const expiresAt = new Date();
      expiresAt.setDate(expiresAt.getDate() + promo.duration_days);

      // Определить план из промокода (по умолчанию PREMIUM)
      const plan = promo.plan || 'PREMIUM';

      // Создать или обновить подписку
      const { error: subError } = await supabase
        .from('subscriptions')
        .upsert({
          telegram_user_id: user_id,
          plan: plan,
          status: 'active',
          expires_at: expiresAt.toISOString(),
          created_at: new Date().toISOString()
        }, {
          onConflict: 'telegram_user_id'
        });

      if (subError) throw subError;

      // Записать использование промокода
      await supabase
        .from('promo_uses')
        .insert({
          promo_code_id: promo.id,
          telegram_user_id: user_id
        });

      // Увеличить счётчик использований
      await supabase
        .from('promo_codes')
        .update({ used_count: (promo.used_count || 0) + 1 })
        .eq('id', promo.id);

      console.log(`Promo ${code} applied for user ${user_id}, plan: ${plan}, expires: ${expiresAt.toISOString()}`);

      return res.status(200).json({
        success: true,
        message: `${plan} активирован на ${promo.duration_days} дней!`,
        plan: plan,
        expires_at: expiresAt.toISOString()
      });

    } catch (error) {
      console.error('Promo error:', error);
      return res.status(500).json({ success: false, message: 'Ошибка сервера' });
    }
  }

  // ========== DELETE ACCOUNT ==========
  if (action === 'delete') {
    try {
      // Удалить все данные пользователя
      await supabase.from('telegram_chats').delete().eq('telegram_user_id', user_id);
      await supabase.from('checkins').delete().eq('telegram_user_id', user_id);
      await supabase.from('goals').delete().eq('telegram_user_id', user_id);
      await supabase.from('reminders').delete().eq('telegram_user_id', user_id);
      await supabase.from('user_preferences').delete().eq('telegram_user_id', user_id);
      await supabase.from('subscriptions').delete().eq('telegram_user_id', user_id);
      await supabase.from('message_summaries').delete().eq('telegram_user_id', user_id);
      await supabase.from('mood_tracking').delete().eq('telegram_user_id', user_id);
      await supabase.from('portraits').delete().eq('telegram_user_id', user_id);

      console.log(`All data deleted for user ${user_id}`);

      return res.status(200).json({ success: true });
    } catch (error) {
      console.error('Delete error:', error);
      return res.status(500).json({ success: false, message: 'Ошибка удаления' });
    }
  }

  return res.status(400).json({ error: 'Unknown action' });
}
