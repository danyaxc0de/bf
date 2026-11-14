import telebot
from telebot.types import LabeledPrice, InlineKeyboardMarkup, InlineKeyboardButton
import os
import requests
import sqlite3
import time

BOT_TOKEN = os.getenv('BOT_TOKEN')
bot = telebot.TeleBot(BOT_TOKEN)
APP_URL = os.getenv('APP_URL', 'https://bf-k8rg.onrender.com')
ADMIN_ID = 8192413936

def get_db():
    return sqlite3.connect('/tmp/app.db')

@bot.message_handler(commands=['start'])
def start(message):
    markup = InlineKeyboardMarkup()
    markup.add(InlineKeyboardButton("⭐ Купить Premium", callback_data="menu_premium"))
    markup.add(InlineKeyboardButton("💎 Купить ЮКи", callback_data="menu_coins"))
    markup.add(InlineKeyboardButton("💬 Поддержка", url="https://t.me/твой_ник")) # ЗАМЕНИ
    markup.add(InlineKeyboardButton("📢 Наш канал", url="https://t.me/BubMagnat"))
    
    text = (
        "👋 Привет! Это **BubFind** — приложение для поиска свободных юзернеймов.\n\n"
        "🔹 Жми кнопку **«Открыть»** внизу, чтобы зайти в приложение и начать искать.\n"
        "🔹 Здесь ты можешь найти редкие ники и забрать их себе."
    )
    bot.send_message(message.chat.id, text, reply_markup=markup, parse_mode='Markdown')

@bot.callback_query_handler(func=lambda call: call.data == "menu_premium")
def menu_premium(call):
    markup = InlineKeyboardMarkup()
    markup.add(InlineKeyboardButton("1 День (10 ⭐) + 20 ЮК", callback_data="pay_premium_day"))
    markup.add(InlineKeyboardButton("1 Неделя (70 ⭐) + 150 ЮК", callback_data="pay_premium_week"))
    markup.add(InlineKeyboardButton("1 Месяц (300 ⭐) + 500 ЮК", callback_data="pay_premium_month"))
    markup.add(InlineKeyboardButton("Навсегда (999 ⭐) + 1000 ЮК", callback_data="pay_premium_forever"))
    bot.edit_message_text("Выбери тариф Premium:", call.message.chat.id, call.message.message_id, reply_markup=markup)

@bot.callback_query_handler(func=lambda call: call.data == "menu_coins")
def menu_coins(call):
    markup = InlineKeyboardMarkup()
    markup.add(InlineKeyboardButton("50 ЮК (25 ⭐)", callback_data="pay_coins_50"))
    markup.add(InlineKeyboardButton("150 ЮК (70 ⭐)", callback_data="pay_coins_150"))
    markup.add(InlineKeyboardButton("500 ЮК (200 ⭐)", callback_data="pay_coins_500"))
    bot.edit_message_text("Выбери пакет ЮКов:", call.message.chat.id, call.message.message_id, reply_markup=markup)

@bot.callback_query_handler(func=lambda call: call.data.startswith("pay_"))
def process_payment(call):
    raw_plan = call.data.replace("pay_", "")
    if raw_plan.startswith('coins_'):
        coins = raw_plan.replace('coins_', '')
        prices = {'50': 25, '150': 70, '500': 200}
        bot.send_invoice(chat_id=call.message.chat.id, title=f"Покупка {coins} ЮКов", description=f"Пакет {coins} ЮКов", invoice_payload=f"coins_{coins}_{call.from_user.id}", provider_token="", currency="XTR", prices=[LabeledPrice(label="ЮКи", amount=prices[coins])])
    else:
        plan = raw_plan.replace('premium_', '')
        prices = {'day': 10, 'week': 70, 'month': 300, 'forever': 999}
        bot.send_invoice(chat_id=call.message.chat.id, title=f"Premium {plan}", description=f"Подписка: {plan}", invoice_payload=f"premium_{plan}_{call.from_user.id}", provider_token="", currency="XTR", prices=[LabeledPrice(label="Premium", amount=prices[plan])])

@bot.pre_checkout_query_handler(func=lambda query: True)
def checkout(pre_checkout_query):
    bot.answer_pre_checkout_query(pre_checkout_query.id, ok=True)

@bot.message_handler(content_types=['successful_payment'])
def got_payment(message):
    parts = message.successful_payment.invoice_payload.split("_")
    p_type, plan, user_id = parts[0], parts[1], parts[2]
    try:
        if p_type == 'coins':
            requests.post(f"{APP_URL}/auth/premium-webhook", json={"telegram_id": user_id, "plan": f"coins_{plan}", "type": "coins"})
            bot.send_message(message.chat.id, "✅ ЮКи зачислены!")
        else:
            requests.post(f"{APP_URL}/auth/premium-webhook", json={"telegram_id": user_id, "plan": plan, "type": "premium"})
            bot.send_message(message.chat.id, "✅ Premium активирован!")
    except:
        bot.send_message(message.chat.id, "Ошибка. Напиши в поддержку.")

@bot.message_handler(commands=['admin'])
def admin_panel(message):
    if message.from_user.id != ADMIN_ID: return
    markup = InlineKeyboardMarkup()
    markup.add(InlineKeyboardButton("🍩 Все ники", callback_data="admin_finds_0"))
    markup.add(InlineKeyboardButton("👤 Найти юзера", callback_data="admin_find_user"))
    markup.add(InlineKeyboardButton("🎟 Создать промокод", callback_data="admin_promo"))
    bot.send_message(message.chat.id, "🛡️ Админ-панель:", reply_markup=markup)

@bot.callback_query_handler(func=lambda call: call.data.startswith("admin_finds_"))
def admin_finds(call):
    if call.from_user.id != ADMIN_ID: return
    filter_status = int(call.data.replace("admin_finds_", ""))
    conn = get_db(); cursor = conn.cursor()
    if filter_status == 0: cursor.execute("SELECT id, username, score, is_hidden, claimed_by FROM found_usernames ORDER BY found_at DESC LIMIT 10")
    elif filter_status == 1: cursor.execute("SELECT id, username, score, is_hidden, claimed_by FROM found_usernames WHERE is_hidden = 0 ORDER BY found_at DESC LIMIT 10")
    else: cursor.execute("SELECT id, username, score, is_hidden, claimed_by FROM found_usernames WHERE is_hidden = 1 ORDER BY found_at DESC LIMIT 10")
    rows = cursor.fetchall(); conn.close()
    text = "🍩 Найденные ники:\n\n"; markup = InlineKeyboardMarkup()
    for row in rows:
        id, uname, score, is_hidden, claimed_by = row
        status = "👁 Выдан" if is_hidden == 0 else "🙈 Скрыт"
        if claimed_by: status += f" ({claimed_by})"
        text += f"@{uname} | {score} | {status}\n"
        action = "👁 Показать" if is_hidden == 1 else "🙈 Скрыть"
        markup.add(InlineKeyboardButton(f"{action} @{uname}", callback_data=f"toggle_{id}"))
    markup.add(InlineKeyboardButton("Все", callback_data="admin_finds_0"))
    markup.add(InlineKeyboardButton("Только выданные", callback_data="admin_finds_1"))
    markup.add(InlineKeyboardButton("Только скрытые", callback_data="admin_finds_2"))
    bot.edit_message_text(text, call.message.chat.id, call.message.message_id, reply_markup=markup)

@bot.callback_query_handler(func=lambda call: call.data.startswith("toggle_"))
def admin_toggle(call):
    if call.from_user.id != ADMIN_ID: return
    find_id = call.data.replace("toggle_", "")
    conn = get_db(); cursor = conn.cursor()
    cursor.execute("SELECT is_hidden FROM found_usernames WHERE id = ?", (find_id,))
    current = cursor.fetchone()[0]
    new_status = 0 if current == 1 else 1
    cursor.execute("UPDATE found_usernames SET is_hidden = ? WHERE id = ?", (new_status, find_id))
    conn.commit(); conn.close()
    bot.answer_callback_query(call.id, "Статус обновлен!")
    admin_finds(call)

bot.polling()
