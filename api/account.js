// api/account.js
// Объединённый endpoint для: промокодов и удаления аккаунта
// Заменяет: promo.js + delete-account.js

import { createClient } from '@supabase/supabase-js';

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_ANON_KEY
);

export default async function handler(req, res) {
  // CORS
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-Telegram-Init-Data');

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const { action, user_id } = req.body;

  if (!user_id) {
    return res.status(400).json({ success: false, message: 'user_id required' });
  }

  // ==================== APPLY PROMO ====================
  if (action === 'apply-promo') {
    const { code } = req.body;

    if (!code) {
      return res.status(400).json({ success: false, message: 'Промокод не указан' });
    }

    try {
      // 1. Найти промокод в базе
      const { data: voucher, error: voucherError } = await supabase
        .from('premium_vouchers')
        .select('*')
        .eq('code', code.toUpperCase())
        .single();

      if (voucherError || !voucher) {
        return res.status(400).json({ 
          success: false, 
          message: 'Промокод недействителен или истёк' 
        });
      }

      // 2. Проверить срок действия промокода
      if (voucher.expires_at && new Date(voucher.expires_at) < new Date()) {
        return res.status(400).json({ 
          success: false, 
          message: 'Срок действия промокода истёк' 
        });
      }

      // 3. Проверить лимит использований
      if (voucher.max_uses !== null && voucher.used_count >= voucher.max_uses) {
        return res.status(400).json({ 
          success: false, 
          message: 'Промокод больше не действителен' 
        });
      }

      // 4. Проверить, не использовал ли уже этот юзер
      const { data: existingUsage } = await supabase
        .from('voucher_usage')
        .select('id')
        .eq('voucher_id', voucher.id)
        .eq('user_id', user_id)
        .single();

      if (existingUsage) {
        return res.status(400).json({ 
          success: false, 
          message: 'Ты уже использовал этот промокод' 
        });
      }

      // 5. Вычислить дату окончания Premium
      const daysToAdd = voucher.duration_days || 7;
      const expiresAt = new Date();
      expiresAt.setDate(expiresAt.getDate() + daysToAdd);

      // 6. Обновить пользователя на PREMIUM
      const { error: updateError } = await supabase
        .from('users')
        .update({
          plan: 'PREMIUM',
          subscription_expires_at: expiresAt.toISOString(),
          messages_limit: 2000
        })
        .eq('telegram_id', user_id);

      if (updateError) {
        console.error('Update user error:', updateError);
        return res.status(500).json({ 
          success: false, 
          message: 'Ошибка активации' 
        });
      }

      // 7. Записать использование промокода
      await supabase
        .from('voucher_usage')
        .insert({
          voucher_id: voucher.id,
          user_id: user_id,
          used_at: new Date().toISOString()
        });

      // 8. Увеличить used_count в промокоде
      await supabase
        .from('premium_vouchers')
        .update({ used_count: (voucher.used_count || 0) + 1 })
        .eq('id', voucher.id);

      // 9. Форматировать дату для ответа
      const months = [
        'января', 'февраля', 'марта', 'апреля', 'мая', 'июня',
        'июля', 'августа', 'сентября', 'октября', 'ноября', 'декабря'
      ];
      const day = expiresAt.getDate();
      const month = months[expiresAt.getMonth()];
      const year = expiresAt.getFullYear();
      const expiresAtFormatted = `${day} ${month} ${year}`;

      return res.status(200).json({
        success: true,
        message: `Premium активирован на ${daysToAdd} дней!`,
        expiresAt: expiresAtFormatted,
        plan: 'PREMIUM',
        messagesLimit: 2000
      });

    } catch (error) {
      console.error('Promo error:', error);
      return res.status(500).json({ 
        success: false, 
        message: 'Ошибка сервера' 
      });
    }
  }

  // ==================== DELETE ACCOUNT ====================
  if (action === 'delete') {
    try {
      // 1. Удалить сообщения пользователя
      await supabase
        .from('messages')
        .delete()
        .eq('user_id', user_id);

      // 2. Удалить цели пользователя
      await supabase
        .from('goals')
        .delete()
        .eq('user_id', user_id);

      // 3. Удалить чекины
      await supabase
        .from('checkins')
        .delete()
        .eq('user_id', user_id);

      // 4. Удалить использования промокодов
      await supabase
        .from('voucher_usage')
        .delete()
        .eq('user_id', user_id);

      // 5. Удалить напоминания
      await supabase
        .from('reminders')
        .delete()
        .eq('user_id', user_id);

      // 6. Удалить самого пользователя
      const { error: deleteError } = await supabase
        .from('users')
        .delete()
        .eq('telegram_id', user_id);

      if (deleteError) {
        console.error('Delete user error:', deleteError);
        return res.status(500).json({ 
          success: false, 
          message: 'Ошибка удаления аккаунта' 
        });
      }

      return res.status(200).json({
        success: true,
        message: 'Все данные удалены'
      });

    } catch (error) {
      console.error('Delete account error:', error);
      return res.status(500).json({ 
        success: false, 
        message: 'Ошибка сервера' 
      });
    }
  }

  // ==================== UNKNOWN ACTION ====================
  return res.status(400).json({ 
    success: false, 
    message: 'Неизвестное действие. Используй action: "apply-promo" или "delete"' 
  });
}
