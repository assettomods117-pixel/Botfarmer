const mineflayer = require('mineflayer');
const { pathfinder, Movements, goals } = require('mineflayer-pathfinder');
const vec3 = require('vec3');

const BED_TIME = 12000;
let following = false;
let targetPlayer = null;
let farmCenter = null;

const bot = mineflayer.createBot({
    username: "TrigoBot",
    host: "1.lemehost.com",
    port: 32268,
    version: false,
    checkTimeoutInterval: 600000,   // Alta tolerância contra lag
});

let mcData;

bot.loadPlugin(pathfinder);

bot.on('kicked', (reason) => console.log('Kicked:', reason));
bot.on('error', (err) => console.log('Error:', err.message));
bot.on('end', () => {
    console.log('Bot caiu. Reiniciando em 10 segundos...');
    setTimeout(() => process.exit(1), 10000);
});

bot.once('spawn', async () => {
    mcData = require('minecraft-data')(bot.version);

    const movements = new Movements(bot, mcData);
    movements.canDig = true;
    bot.pathfinder.setMovements(movements);

    console.log("TrigoBot 24/7 iniciado");
    await autoSetupAndFarm();
});

// ===================== COMANDOS =====================
bot.on('chat', (username, message) => {
    if (username === bot.username) return;
    const msg = message.toLowerCase().trim();
    const args = message.trim().split(/\s+/);

    if (msg === 'seguir') {
        targetPlayer = bot.players[username]?.entity;
        if (targetPlayer) {
            following = true;
            bot.chat(`Seguindo ${username}`);
        } else {
            bot.chat("Não te encontrei.");
        }
    }

    if (msg === 'stop') {
        following = false;
        bot.pathfinder.setGoal(null);
        bot.chat("Parando de seguir.");
    }

    if (msg === 'status') {
        const wheat = bot.inventory.count(mcData.itemsByName.wheat?.id || 0);
        const seeds = bot.inventory.count(mcData.itemsByName.wheat_seeds?.id || 0);
        const slots = bot.inventory.emptySlotCount();
        bot.chat(`Status → Trigo: ${wheat} | Sementes: ${seeds} | Slots livres: ${slots}`);
    }

    if (args[0] === 'setfarm') {
        farmCenter = bot.entity.position.floored();
        bot.chat("Centro da farm definido com sucesso!");
    }
});

// ===================== NAVEGAÇÃO ANTI-DESISTÊNCIA =====================
async function goTo(position, range = 2) {
    try {
        bot.pathfinder.setGoal(new goals.GoalNear(position.x, position.y, position.z, range));
        let ticks = 0;
        const maxWait = 120; // espera até \~1 minuto se necessário

        while (bot.entity.position.distanceTo(position) > range + 2 && ticks < maxWait) {
            await bot.waitForTicks(8);
            ticks++;
        }
        bot.pathfinder.setGoal(null);
    } catch (e) {}
}

async function returnToFarm() {
    if (!farmCenter) return;
    await goTo(farmCenter, 8);
}

async function followPlayer() {
    if (!following || !targetPlayer) return;
    try {
        const goal = new goals.GoalNear(
            targetPlayer.position.x, 
            targetPlayer.position.y, 
            targetPlayer.position.z, 
            5
        );
        bot.pathfinder.setGoal(goal);
    } catch (e) {}
}

// ===================== FUNÇÕES =====================
function hasItem(name) {
    return bot.inventory.count(mcData.itemsByName[name]?.id || 0) > 0;
}

async function pickupNearbyItems() {
    const items = Object.values(bot.entities).filter(e => 
        e.name === 'item' && bot.entity.position.distanceTo(e.position) <= 8
    );

    for (const item of items) {
        try {
            await goTo(item.position, 1);
            await bot.waitForTicks(8);
        } catch (e) {}
    }
}

async function depositIfTooMuchWheat() {
    const wheatCount = bot.inventory.count(mcData.itemsByName.wheat?.id || 0);
    if (wheatCount <= 32) return;

    const chest = bot.findBlock({ matching: b => b.name === 'chest', maxDistance: 40 });
    if (!chest) return;

    await goTo(chest.position, 2);

    try {
        const window = await bot.openChest(chest);
        for (const slot of bot.inventory.slots) {
            if (slot && slot.name === 'wheat') {
                await window.deposit(slot.type, null, slot.count);
            }
        }
        window.close();
        bot.chat(`Guardei trigo no baú.`);
        await returnToFarm();
    } catch (e) {}
}

async function sleepInBed() {
    const bed = bot.findBlock({ matching: bot.isABed, maxDistance: 32 });
    if (!bed) return;
    await goTo(bed.position, 2);
    try { await bot.sleep(bed); } catch (e) {}
}

// ===================== LOOP PRINCIPAL =====================
async function mainLoop() {
    while (true) {
        try {
            if (following) {
                await followPlayer();
            } else {
                await pickupNearbyItems();
                await depositIfTooMuchWheat();

                if (bot.time.timeOfDay > BED_TIME) await sleepInBed();

                await harvestCrops();
                await fillFarmland();
            }
            await bot.waitForTicks(25);
        } catch (e) {
            await bot.waitForTicks(30);
        }
    }
}

async function harvestCrops() {
    const crop = bot.findBlock({
        matching: b => b.name === 'wheat' && b.metadata === 7,
        maxDistance: 60
    });
    if (!crop) return;
    await goTo(crop.position, 1.5);
    await bot.dig(crop);
    await bot.waitForTicks(10);
}

async function fillFarmland() {
    const farms = await bot.findBlocks({
        matching: b => b.name === "farmland",
        maxDistance: 50,
        count: 80
    });

    for (const pos of farms) {
        if (bot.blockAt(pos.offset(0,1,0)).name === 'air') {
            await goTo(pos, 2);
            if (!hasItem('wheat_seeds')) await getSeeds();
            await safeEquip('wheat_seeds');
            await bot.activateBlock(bot.blockAt(pos), vec3(0,1,0)).catch(() => {});
            return;
        }
    }
}

// ===================== SETUP =====================
async function autoSetupAndFarm() {
    await getWood(4);
    await craftWoodenHoe();
    await getSeeds();
    await createBasicFarm();
    mainLoop();
}

async function getWood(amount = 4) { /* silencioso */ }
async function craftWoodenHoe() { if (!hasItem('wooden_hoe')) await safeEquip('wooden_hoe'); }
async function getSeeds() { /* silencioso */ }
async function createBasicFarm() { 
    const blocks = await bot.findBlocks({
        matching: b => ['grass_block', 'dirt'].includes(b.name),
        maxDistance: 25,
        count: 100
    });

    let farmPos = blocks.find(p => 
        bot.entity.position.distanceTo(p) >= 4 &&
        bot.blockAt(p.offset(0,1,0)).name === 'air' &&
        bot.blockAt(p.offset(0,2,0)).name === 'air'
    );

    if (farmPos) {
        farmCenter = farmPos;
        await goTo(farmPos);
        await safeEquip('wooden_hoe');
        const dirt = bot.blockAt(farmPos);
        await bot.activateBlock(dirt, vec3(0,1,0)).catch(() => {});

        await bot.waitForTicks(10);
        await safeEquip('wheat_seeds');
        await bot.activateBlock(dirt, vec3(0,1,0)).catch(() => {});
    }
}

async function safeEquip(name) {
    const item = bot.inventory.items().find(i => i.name === name);
    if (item) await bot.equip(item, 'hand').catch(() => {});
}

console.log("TrigoBot 24/7 iniciado - Modo anti-desistência");
