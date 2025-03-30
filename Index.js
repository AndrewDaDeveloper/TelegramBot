require("dotenv").config();
const fs = require("fs");
const TelegramBot = require("node-telegram-bot-api");
const { Together } = require("together-ai");
const stringSimilarity = require("string-similarity");

// ✅ Load JSON Data
function loadBotData() {
    try {
        const rawData = fs.readFileSync("data.json", "utf8");
        return JSON.parse(rawData);
    } catch (error) {
        console.error("❌ Error loading data.json:", error);
        return { verification_keywords: [], verification_reference: "⚠️ بيانات التوثيق غير متاحة." };
    }
}

let botData = loadBotData();

// ✅ Load Verified Users
function loadVerifiedUsers() {
    try {
        const rawData = fs.readFileSync("verified_users.json", "utf8");
        return JSON.parse(rawData);
    } catch (error) {
        return {};
    }
}

// ✅ Save Verified Users
function saveVerifiedUsers(users) {
    fs.writeFileSync("verified_users.json", JSON.stringify(users, null, 2));
}

let verifiedUsers = loadVerifiedUsers();

// ✅ Store Last Sent Verification Message ID
const messageDataFile = "last_verification_message.json";

function loadLastVerificationMessage() {
    try {
        const rawData = fs.readFileSync(messageDataFile, "utf8");
        return JSON.parse(rawData);
    } catch (error) {
        return { messageId: null };
    }
}

function saveLastVerificationMessage(messageId) {
    fs.writeFileSync(messageDataFile, JSON.stringify({ messageId }));
}

let lastVerificationMessage = loadLastVerificationMessage();

// ✅ Initialize Telegram Bot & Together AI
const bot = new TelegramBot(process.env.TELEGRAM_BOT_TOKEN, { polling: true });
const together = new Together({ apiKey: process.env.TOGETHER_AI_API_KEY });

const ADMIN_ID = Number(process.env.ADMIN_ID);
const PUBLIC_CHANNEL_ID = Number(process.env.PUBLIC_CHANNEL_ID);
const RESTRICTED_TOPIC_ID = Number(process.env.RESTRICTED_TOPIC_ID); // ❗ Topic where users can't send messages

const verificationSessions = {};
const pendingApprovals = {};

// ✅ Restrict Members from Sending Messages in a Specific Topic
bot.on("message", async (msg) => {
    const userId = msg.from.id;
    const userInput = msg.text?.trim();
    const chatId = msg.chat.id;
    const topicId = msg.message_thread_id;

    // ❌ If message is in the restricted topic and user is not admin, delete it
    if (topicId === RESTRICTED_TOPIC_ID && userId !== ADMIN_ID) {
        try {
            await bot.deleteMessage(chatId, msg.message_id);
            return;
        } catch (error) {
            console.error("❌ Error deleting message:", error);
        }
    }

    // ✅ Handle Verification Answer
    if (verificationSessions[userId] && userInput) {
        pendingApprovals[userId] = { question: verificationSessions[userId].question, answer: userInput };

        bot.sendMessage(
            ADMIN_ID,
            `🔔 **طلب تحقق جديد!**\n👤 المستخدم: ${msg.from.first_name}\n\n📝 **سؤال التحقق:**\n${verificationSessions[userId].question}\n\n✍️ **إجابة المستخدم:**\n${userInput}`,
            {
                reply_markup: {
                    inline_keyboard: [
                        [{ text: "✅ قبول", callback_data: `approve_${userId}` }],
                        [{ text: "❌ رفض", callback_data: `reject_${userId}` }]
                    ]
                }
            }
        );

        bot.sendMessage(userId, "⏳ تم إرسال إجابتك إلى المسؤول. انتظر الموافقة...");
        delete verificationSessions[userId];
    }
});

// ✅ Admin Command to Send or Update Verification Message
bot.onText(/\/sendverify/, async (msg) => {
    const userId = msg.from.id;

    if (userId !== ADMIN_ID) {
        bot.sendMessage(userId, "❌ هذا الأمر مخصص فقط للمسؤول.");
        return;
    }

    const verificationText = "📢 هل ترغب في التقدم للتحقق؟ اضغط على الزر أدناه لبدء العملية.";
    const verificationKeyboard = {
        reply_markup: {
            inline_keyboard: [[{ text: "📝 التقدم للتحقق", callback_data: "start_verification" }]]
        }
    };

    if (lastVerificationMessage.messageId) {
        try {
            await bot.editMessageText(verificationText, {
                chat_id: PUBLIC_CHANNEL_ID,
                message_id: lastVerificationMessage.messageId,
                ...verificationKeyboard
            });
            bot.sendMessage(userId, "✅ تم تحديث رسالة التحقق بنجاح!");
            return;
        } catch (error) {
            console.log("⚠️ Previous verification message not found. Sending a new one...");
        }
    }

    const message = await bot.sendMessage(PUBLIC_CHANNEL_ID, verificationText, verificationKeyboard);
    lastVerificationMessage.messageId = message.message_id;
    saveLastVerificationMessage(message.message_id);

    bot.sendMessage(userId, "✅ تم إرسال رسالة التحقق بنجاح!");
});

// ✅ Handle "Apply for Verification" Button
bot.on("callback_query", (query) => {
    const userId = query.from.id;

    if (query.data === "start_verification") {
        if (verifiedUsers[userId]) {
            bot.sendMessage(userId, "✅ أنت بالفعل مستخدم موثق.");
            return;
        }

        const verificationQuestion = "ما هو الهدف من التوثيق؟";
        verificationSessions[userId] = { question: verificationQuestion };

        bot.sendMessage(userId, `📝 **سؤال التحقق:**\n${verificationQuestion}\n\n💡 **أرسل إجابتك الآن.**`, { parse_mode: "Markdown" });
    }

    bot.answerCallbackQuery(query.id);
});

// ✅ Admin Approval System
bot.on("callback_query", (query) => {
    let [action, userId] = query.data.split("_");
    userId = Number(userId);

    if (!pendingApprovals[userId]) return;

    if (action === "approve") {
        verifiedUsers[userId] = true;
        saveVerifiedUsers(verifiedUsers);
        bot.sendMessage(userId, "🎉 تهانينا! تم توثيق حسابك بنجاح.");
    } else if (action === "reject") {
        bot.sendMessage(userId, "❌ تم رفض طلب التوثيق الخاص بك.");
    }

    delete pendingApprovals[userId];
    bot.answerCallbackQuery(query.id);
});

// ✅ Handle /chat Command
bot.onText(/\/chat (.+)/, async (msg, match) => {
    const userId = msg.from.id;
    const userMessage = match[1];

    bot.sendMessage(userId, "🤖 Thinking...");
    const response = await generateVerificationResponse(userMessage);
    bot.sendMessage(userId, response);
});

// ✅ Generate AI Response for Verification
async function generateVerificationResponse(userInput) {
    try {
        const response = await together.chat.completions.create({
            model: "meta-llama/Llama-3.3-70B-Instruct-Turbo",
            messages: [
                { 
                    role: "system", 
                    content: `أنت مساعد ذكاء اصطناعي مخصص للإجابة على أسئلة التوثيق.
                              لا تقم فقط بنسخ المعلومات المرجعية، بل استوعبها وأعد صياغتها بأساليب مختلفة، 
                              مع الحفاظ على الجوهر والمعنى الأساسي. اجعل كل إجابة تبدو فريدة ومفهومة.` 
                },
                { role: "user", content: `📌 **مرجع التوثيق:**\n${botData.verification_reference}\n\n
                              📝 فهم هذا المرجع جيدًا، ثم أعد صياغته بطريقة جديدة للإجابة على السؤال التالي:` },
                { role: "user", content: `❓ السؤال: ${userInput}` }
            ],
        });

        return response.choices?.[0]?.message?.content.trim() || "❌ لم أتمكن من توليد استجابة.";
    } catch (error) {
        console.error("❌ Together API Error:", error);
        return "⚠️ الخدمة غير متاحة حاليًا، حاول لاحقًا.";
    }
};

// ✅ Bot Start
console.log("🤖 Bot Loaded and Running!");
