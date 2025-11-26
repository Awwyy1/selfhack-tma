import { supabase } from '../lib/supabase.js';

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method Not Allowed' });
  }

  const { user_id, promo_code } = req.body;

  if (!user_id || !promo_code) {
    return res.status(400).json({
      error: 'Missing parameters',
      message: 'Укажи промокод'
    });
  }

  try {
    // Проверить существует ли промокод и активен ли он
    const { data: promo, error: promoError } = await supabase
      .from('premium_vouchers')
      .select('*')
      .eq('code', promo_code.toUpperCase().trim())
      .maybeSingle();

    if (promoError) {
      throw promoError;
    }

    if (!promo) {
      return res.status(404).json({
        success: false,
        message: 'Промокод не найден'
      });
    }

    // Проверить не истёк ли промокод
    if (promo.expires_at && new Date(promo.expires_at) < new Date()) {
      return res.status(400).json({
        success: false,
        message: 'Промокод истёк'
      });
    }

    // Проверить не достигнут ли лимит использования
    if (promo.max_uses && promo.used_count >= promo.max_uses) {
      return res.status(400).json({
        success: false,
        message: 'Промокод больше не действителен'
      });
    }

    // Проверить не использовал ли пользователь уже этот промокод
    const { data: existingUsage } = await supabase
      .from('voucher_usage')
      .select('*')
      .eq('telegram_user_id', user_id)
      .eq('voucher_id', promo.id)
      .maybeSingle();

    if (existingUsage) {
      return res.status(400).json({
        success: false,
        message: 'Ты уже использовал этот промокод'
      });
    }

    // Рассчитать дату окончания подписки
    const now = new Date();
    const expiresAt = new Date(now);
    expiresAt.setDate(expiresAt.getDate() + promo.duration_days);

    // Проверить есть ли уже активная подписка
    const { data: existingSub } = await supabase
      .from('subscriptions')
      .select('*')
      .eq('telegram_user_id', user_id)
      .eq('status', 'active')
      .maybeSingle();

    if (existingSub && new Date(existingSub.expires_at) > now) {
      // Продлить существующую подписку
      const newExpiry = new Date(existingSub.expires_at);
      newExpiry.setDate(newExpiry.getDate() + promo.duration_days);

      await supabase
        .from('subscriptions')
        .update({
          expires_at: newExpiry.toISOString(),
          updated_at: now.toISOString()
        })
        .eq('id', existingSub.id);
    } else {
      // Создать новую подписку или обновить неактивную
      await supabase
        .from('subscriptions')
        .upsert({
          telegram_user_id: user_id,
          plan: promo.plan || 'premium',
          status: 'active',
          expires_at: expiresAt.toISOString(),
          payment_method: 'promo',
          created_at: now.toISOString(),
          updated_at: now.toISOString()
        }, {
          onConflict: 'telegram_user_id'
        });
    }

    // Записать использование промокода
    await supabase
      .from('voucher_usage')
      .insert({
        telegram_user_id: user_id,
        voucher_id: promo.id,
        used_at: now.toISOString()
      });

    // Увеличить счётчик использования промокода
    await supabase
      .from('premium_vouchers')
      .update({
        used_count: (promo.used_count || 0) + 1
      })
      .eq('id', promo.id);

    console.log(`✅ Promo activated: user ${user_id}, code ${promo_code}, duration ${promo.duration_days} days`);

    return res.status(200).json({
      success: true,
      message: `Промокод активирован! Подписка продлена на ${promo.duration_days} дней.`,
      duration_days: promo.duration_days,
      expires_at: expiresAt.toISOString()
    });

  } catch (error) {
    console.error('❌ Promo API error:', error);
    return res.status(500).json({
      error: 'Internal error',
      message: 'Ошибка при активации промокода'
    });
  }
}
