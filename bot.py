import os
import telebot
import requests

BOT_TOKEN = os.getenv("BOT_TOKEN")
API_URL = os.getenv("BOT_API_URL", "http://localhost:3000")

bot = telebot.TeleBot(BOT_TOKEN)

@bot.message_handler(commands=['start'])
def start(message):
    args = message.text.split()
    if len(args) > 1:
        payload = args[1]
        if payload.startswith('auth_'):
            token = payload.split('_')[1]
            try:
                res = requests.post(f"{API_URL}/auth/telegram-confirm", json={"token": token, "telegram_id": str(message.from_user.id)}, timeout=10)
                if res.status_code == 200:
                    bot.send_message(message.chat.id, "✅ Вход подтвержден! Возвращайся в приложение.")
                else:
                    bot.send_message(message.chat.id, "❌ Ошибка входа. Попробуй еще раз.")
            except Exception as e:
                bot.send_message(message.chat.id, f"❌ Ошибка сети: {e}")
        elif payload.startswith('buy_'):
            bot.send_message(message.chat.id, "💳 Здесь будет оплата Premium (в разработке).")
    else:
        bot.send_message(message.chat.id, "Привет! Зайди в приложение BubFind и нажми 'Войти через Telegram'.")

bot.infinity_polling()
