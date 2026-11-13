import telebot
from telebot.types import LabeledPrice
import os
import requests

BOT_TOKEN = os.getenv('BOT_TOKEN')
bot = telebot.TeleBot(BOT_TOKEN)
APP_URL = os.getenv('APP_URL', 'https://bubfind.js.org')

@bot.message_handler(commands=['start'])
def start(message):
    markup = telebot.types.InlineKeyboardMarkup()
    markup.add(telebot.types.InlineKeyboardButton("⭐ Купить Premium", callback_data="menu_premium"))
    markup.add(telebot.types.InlineKeyboardButton("💎 Купить ЮКи", callback_data="menu_coins"))
    bot.send_message(message.chat.id, "Привет! Это BubFind. Что хочешь приобрести?", reply_markup=markup)

@bot.callback_query_handler(func=lambda call: call.data == "menu_premium")
def menu_premium(call):
    markup = telebot.types.InlineKeyboardMarkup()
    markup.add(telebot.types.InlineKeyboardButton("1 День (10 ⭐) + 20 ЮК", callback_data="pay_premium_day"))
    markup.add(telebot.types.InlineKeyboardButton("1 Неделя (70 ⭐) + 150 ЮК", callback_data="pay_premium_week"))
    markup.add(telebot.types.InlineKeyboardButton("1 Месяц (300 ⭐) + 700 ЮК", callback_data="pay_premium_month"))
    markup.add(telebot.types.InlineKeyboardButton("Навсегда (999 ⭐) + 5000 ЮК", callback_data="pay_premium_forever"))
    bot.edit_message_text("Выбери тариф Premium:", call.message.chat.id, call.message.message_id, reply_markup=markup)

@bot.callback_query_handler(func=lambda call: call.data == "menu_coins")
def menu_coins(call):
    markup = telebot.types.InlineKeyboardMarkup()
    markup.add(telebot.types.InlineKeyboardButton("50 ЮК (25 ⭐)", callback_data="pay_coins_50"))
    markup.add(telebot.types.InlineKeyboardButton("150 ЮК (70 ⭐)", callback_data="pay_coins_150"))
    markup.add(telebot.types.InlineKeyboardButton("500 ЮК (200 ⭐)", callback_data="pay_coins_500"))
    bot.edit_message_text("Выбери пакет ЮКов:", call.message.chat.id, call.message.message_id, reply_markup=markup)

@bot.callback_query_handler(func=lambda call: call.data.startswith("pay_"))
def process_payment(call):
    raw_plan = call.data.replace("pay_", "")
    
    if raw_plan.startswith('coins_'):
        coins = raw_plan.replace('coins_', '')
        prices = {'50': 25, '150': 70, '500': 200}
        price = prices.get(coins, 0)
        bot.send_invoice(
            chat_id=call.message.chat.id, title=f"Покупка {coins} ЮКов", description=f"Пакет {coins} ЮКов",
            invoice_payload=f"coins_{coins}_{call.from_user.id}", provider_token="", currency="XTR",
            prices=[LabeledPrice(label="ЮКи", amount=price)],
        )
    elif raw_plan.startswith('premium_'):
        plan = raw_plan.replace('premium_', '')
        prices = {'day': 10, 'week': 70, 'month': 300, 'forever': 999}
        price = prices.get(plan, 0)
        bot.send_invoice(
            chat_id=call.message.chat.id, title=f"Premium {plan}", description=f"Подписка на BubFind: {plan}",
            invoice_payload=f"premium_{plan}_{call.from_user.id}", provider_token="", currency="XTR",
            prices=[LabeledPrice(label="Premium", amount=price)],
        )

@bot.pre_checkout_query_handler(func=lambda query: True)
def checkout(pre_checkout_query):
    bot.answer_pre_checkout_query(pre_checkout_query.id, ok=True)

@bot.message_handler(content_types=['successful_payment'])
def got_payment(message):
    payload = message.successful_payment.invoice_payload
    parts = payload.split("_")
    p_type = parts[0]
    plan = parts[1]
    user_id = parts[2]

    try:
        if p_type == 'coins':
            requests.post(f"{APP_URL}/auth/premium-webhook", json={"telegram_id": user_id, "plan": f"coins_{plan}", "type": "coins"})
            bot.send_message(message.chat.id, "✅ ЮКи зачислены на твой аккаунт!")
        else:
            requests.post(f"{APP_URL}/auth/premium-webhook", json={"telegram_id": user_id, "plan": plan, "type": "premium"})
            bot.send_message(message.chat.id, "✅ Premium активирован! Бонусные ЮКи зачислены.")
    except Exception as e:
        bot.send_message(message.chat.id, "Оплата прошла, но произошла ошибка. Напиши в поддержку.")

bot.polling()
