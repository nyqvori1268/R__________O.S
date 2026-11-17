// ==UserScript==
// @name         RO Survivors 自動遠征
// @namespace    local.ro-survivors.autoplay
// @version      2.1.9
// @author       nyqvori1268
// @homepageURL  https://github.com/nyqvori1268/R__________O.S
// @supportURL   https://github.com/nyqvori1268/R__________O.S/issues
// @updateURL    https://raw.githubusercontent.com/nyqvori1268/R__________O.S/main/ro-survivors-autoplay.user.js
// @downloadURL  https://raw.githubusercontent.com/nyqvori1268/R__________O.S/main/ro-survivors-autoplay.user.js
// @description  依當前角色天賦與官方技能池同步可抽技能、顯示解鎖來源、保留排序與排除、F8自動遠征
// @match        https://ro-survivors.com/*
// @run-at       document-idle
// @grant        none
// @sandbox      raw
// @noframes
// ==/UserScript==

/*
 * 安裝後重新整理遊戲，在右下角設定地圖、難度及職業技能排序，再按 F8。
 * 只有 F8 切換開始／停止，手動走位與 Escape 不會停止。設定只儲存在這個瀏覽器。
 * 已核對 build 85c93f0b、8ea3785e、7fcbdd05 與 11/15 的 10fe0d2f / main-Cw6ZGAii.js。
 * 燈籠節入口與固定難度流程另已核對 build 09c52f73 / main-CVsjfvFO.js。
 * 技能池、武器／盾牌限制與本局道具另已核對 build adc0fdf6 / main-2n_YvaNQ.js。
 * 使用原遊戲模組的 start / tick callbacks 取得場景，移動沿用 moveTo 尋路。
 * 預設先取得未學技能、補齊本局道具欄位，再依類別、品質與配置順序升級，最後以 DPS 估算決定。
 */
(function () {
    'use strict';

    const VERSION = '2.1.9';
    const SETTINGS_KEY = 'ro-autoplay.settings.v1';
    const MODE_SETTINGS_KEY = 'ro-autoplay.mode-settings.v1';
    const PANEL_DEFAULTS = { x: null, y: null, width: 620, height: 720, minimized: false };
    const DEFAULTS = {
        stage: 'first',
        repeat: true,
        maxRuns: 0,
        repeatDelay: 4,
        skillPriority: '',
        skillProfiles: {},
        chestProfiles: {},
        chestReroll: true,
        autoCardReroll: true,
        autoBanish: true,
        autoFocus: true,
        focusTopCount: 1,
        cardRerollMinQuality: 0,
        cardActionLimit: 3,
        learnFirst: true,
        qualityFirst: true,
        stayInGroundAoe: true,
        avoidCorners: true,
        openingFarm: true,
        openingSeconds: 120,
        openingLootRadius: 420,
        resourceFarm: true,
        resourceLootRadius: 900,
        tankThroughDanger: true,
        tankHpPercent: 60,
        recoveryLootRush: true,
        fallbackLockedReroll: true,
        fallbackExhaustedChoices: true,
        safetyMargin: 42,
        lookahead: 0.65,
        normalLootRadius: 180,
        specialLootRadius: 1600,
        decisionMs: 120,
        choiceDelay: 1.15,
        npcOffset: 100,
        pauseOnManual: false,
        offlineLobby: true,
        declineChineseChannel: true,
        settlementLoot: true,
        partyAutoReady: true,
        partyRetryLimit: 3,
        partyRetryDelay: 15,
        panel: PANEL_DEFAULTS,
        difficulty: { count: 1, damage: 1, hp: 1, speed: 1, events: 1 },
    };
    // These automatic rules are not user-facing settings in the compact UI.
    // Apply them to old saves/imports as well as newly created mode profiles.
    const AUTOMATIC_RULES = {
        chestReroll: true, autoCardReroll: true, autoBanish: true, autoFocus: true,
        focusTopCount: 1, cardRerollMinQuality: 0, cardActionLimit: 3,
        learnFirst: true, qualityFirst: true, fallbackLockedReroll: true, fallbackExhaustedChoices: true,
        resourceFarm: true, openingFarm: true, avoidCorners: true, stayInGroundAoe: true,
        tankThroughDanger: true, recoveryLootRush: true, pauseOnManual: false,
        declineChineseChannel: true, settlementLoot: true, partyAutoReady: true,
        partyRetryLimit: 3, partyRetryDelay: 15,
        resourceLootRadius: 900, openingSeconds: 120, openingLootRadius: 420,
        normalLootRadius: 180, specialLootRadius: 1600, safetyMargin: 42, lookahead: 0.65,
        decisionMs: 120, choiceDelay: 1.15, npcOffset: 100, repeatDelay: 4,
    };
    const DIFFICULTY = [
        { key: 'count', name: '敵人數量', max: 3.5 },
        { key: 'damage', name: '敵人傷害', max: 1.75 },
        { key: 'hp', name: '敵人血量', max: 2.5 },
        { key: 'speed', name: '敵人速度', max: 1.75 },
        { key: 'events', name: '事件數量', max: 2.5 },
    ];
    const PARTY_DIFFICULTY = DIFFICULTY.map(item => ({ ...item,
        max: { count: 3, damage: 1.5, hp: 2, speed: 1.5, events: 2 }[item.key] }));
    // Seasonal stages are deliberately omitted from the captain's native list.
    // Keep a stable id so the choice survives list refreshes and language changes.
    const LANTERN_STAGE = { id: 'louyang', name: '燈籠節／洛陽（活動・固定難度）' };
    const CHEST_SLOTS = [
        { id: 'potion', name: '藥水' },
        { id: 'elixir', name: '秘藥' },
        { id: 'blessing', name: '祝福' },
        { id: 'dish', name: '料理' },
        { id: 'deity', name: '神祇（屬性／技能共用）' },
    ];
    const CHEST_CATEGORY_ORDER = ['deity', 'blessing', 'elixir', 'potion', 'dish'];
    const QUALITY_NAMES = ['普通', '優良', '稀有', '史詩', '傳說'];
    const PICKUP_NAMES = { magnet: '磁鐵',
        chest: '寶箱', meat: '補血道具', zeny: '金幣', exp: '經驗', gem_blue: '經驗', gem_yellow: '經驗', gem_red: '經驗' };
    const clamp = (value, low, high) => Math.max(low, Math.min(high, value));
    const distance = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);
    const point = value => value && Number.isFinite(value.x) && Number.isFinite(value.y);
    const normalized = value => String(value ?? '').trim().toLocaleLowerCase().replace(/\s+/g, ' ');

    function isLanternStage(value) {
        return ['louyang', LANTERN_STAGE.name, '燈籠節', '灯笼节', 'lantern festival',
            'festival de los faroles', 'festival das lanternas'].some(name => normalized(value) === normalized(name));
    }

    function departureDialogKind(root) {
        if (root?.querySelector('#npc-text .diff input[data-key]')) return 'standard';
        // The seasonal confirmation only contains the native upgrade controls
        // (plus the optional party choice timer). It has no difficulty/reward row.
        if (root?.querySelector('#npc-text .diff .diff-bank [data-bank="0"]')
            && root.querySelector('#npc-text .diff .diff-bank [data-bank="1"]')
            && !root.querySelector('#npc-text .diff .diff-reward')) return 'fixed';
        return null;
    }

    function townNpcMatches(text, festival, prompt = false) {
        if (!festival) return (prompt ? /隊長|队长|captain|capit[aá]n|capit[aã]o/i
            : /遠征隊長|远征队长|expedition.*captain|capit[aá]n.*expedicion|capit[aã]o.*expedi/i).test(text);
        return (prompt ? /主持人|host|anfitri/i
            : /節慶主持人|节庆主持人|節日主持人|节日主持人|festival.*host|host.*festival|anfitri.*festival/i).test(text);
    }

    function normalizeSettings(input = {}) {
        const result = { ...DEFAULTS, ...input, difficulty: { ...DEFAULTS.difficulty, ...input.difficulty } };
        const limits = {
            maxRuns: [0, 9999], repeatDelay: [1, 300], safetyMargin: [12, 180],
            lookahead: [0.25, 1.2], normalLootRadius: [0, 800], specialLootRadius: [100, 4000],
            decisionMs: [80, 500], choiceDelay: [0.9, 10], npcOffset: [30, 220],
            tankHpPercent: [0, 100],
            openingSeconds: [30, 180], openingLootRadius: [0, 800],
            resourceLootRadius: [0, 2400],
            focusTopCount: [1, 5], cardRerollMinQuality: [0, 4], cardActionLimit: [0, 10],
            partyRetryLimit: [1, 10], partyRetryDelay: [5, 120],
        };
        for (const [key, [low, high]] of Object.entries(limits)) {
            const value = Number(result[key]);
            result[key] = Number.isFinite(value) ? clamp(value, low, high) : DEFAULTS[key];
        }
        result.maxRuns = Math.floor(result.maxRuns);
        for (const key of ['focusTopCount', 'cardRerollMinQuality', 'cardActionLimit', 'partyRetryLimit']) result[key] = Math.floor(result[key]);
        result.stage = typeof result.stage === 'string' ? result.stage : 'first';
        if (isLanternStage(result.stage)) result.stage = LANTERN_STAGE.id;
        result.skillPriority = typeof result.skillPriority === 'string' ? result.skillPriority : '';
        result.skillProfiles = {};
        for (const [job, profile] of Object.entries(input.skillProfiles ?? {})) {
            if (!profile || typeof profile !== 'object') continue;
            result.skillProfiles[job] = normalizeSkillProfile(profile);
        }
        result.chestProfiles = {};
        for (const [job, groups] of Object.entries(input.chestProfiles ?? {})) {
            if (!groups || typeof groups !== 'object') continue;
            result.chestProfiles[job] = {};
            for (const slot of CHEST_SLOTS) if (groups[slot.id]) result.chestProfiles[job][slot.id] = normalizeSkillProfile(groups[slot.id]);
        }
        for (const key of ['repeat', 'learnFirst', 'qualityFirst', 'stayInGroundAoe', 'avoidCorners', 'openingFarm', 'resourceFarm', 'tankThroughDanger', 'recoveryLootRush', 'fallbackLockedReroll', 'fallbackExhaustedChoices', 'pauseOnManual', 'chestReroll', 'offlineLobby', 'declineChineseChannel', 'settlementLoot', 'autoCardReroll', 'autoBanish', 'autoFocus', 'partyAutoReady']) result[key] = Boolean(result[key]);
        for (const { key, max } of DIFFICULTY) {
            const value = Number(result.difficulty[key]);
            result.difficulty[key] = Number.isFinite(value) ? clamp(Math.round(value * 20) / 20, 1, max) : 1;
        }
        const panel = input.panel && typeof input.panel === 'object' ? input.panel : {};
        const size = (key, low, high) => Number.isFinite(panel[key]) ? clamp(panel[key], low, high) : PANEL_DEFAULTS[key];
        result.panel = {
            x: Number.isFinite(panel.x) ? panel.x : null,
            y: Number.isFinite(panel.y) ? panel.y : null,
            width: size('width', 310, 1600), height: size('height', 250, 1400),
            minimized: Boolean(panel.minimized),
        };
        return result;
    }

    function snapshotSettings(input, mode = 'solo') {
        const result = normalizeSettings({ ...input, ...AUTOMATIC_RULES });
        if (mode === 'party') {
            result.offlineLobby = false;
            for (const item of PARTY_DIFFICULTY) result.difficulty[item.key] = Math.min(result.difficulty[item.key], item.max);
        }
        return JSON.parse(JSON.stringify(Object.fromEntries(Object.keys(DEFAULTS).map(key => [key, result[key]]))));
    }

    function normalizeModeStore(input, legacy) {
        const valid = input?.format === 'ro-autoplay-modes' && input.schema === 1 && input.profiles?.solo;
        const profiles = { solo: snapshotSettings(valid ? input.profiles.solo : legacy),
            party: valid && input.profiles.party ? snapshotSettings(input.profiles.party, 'party') : null };
        return { format: 'ro-autoplay-modes', schema: 1,
            activeMode: valid && input.activeMode === 'party' && profiles.party ? 'party' : 'solo',
            panel: normalizeSettings({ panel: valid ? input.panel : legacy?.panel }).panel, profiles };
    }

    // Native party-frame is updated by the game's server party events. Missing
    // or hidden UI during a run/disconnect is unknown, not evidence of leaving.
    function readPartyState(game, root) {
        const get = id => root?.getElementById?.(id) || null;
        const has = (element, name) => element?.classList?.contains(name) === true;
        const lobby = get('lobby-ui'), frame = get('party-frame'), network = get('lobby-online');
        const inLobby = Boolean(lobby && lobby.classList && !has(lobby, 'hidden')
            && (!lobby.getClientRects || lobby.getClientRects().length));
        const online = has(network, 'online');
        const rows = Array.from(frame?.querySelectorAll?.('.pf-row[data-mid]') || []);
        if (frame && !has(frame, 'hidden') && rows.length) {
            const members = rows.map(row => ({ id: String(row.dataset?.mid || ''), self: has(row, 'me'),
                leader: Boolean(row.querySelector?.('.pf-lead')), online: !has(row, 'off'),
                sameChannel: !row.querySelector?.('[data-hop]'), ready: Boolean(row.querySelector?.('.pf-ready')),
                name: row.querySelector?.('.pf-name b')?.textContent?.trim() || '' }));
            const self = members.find(member => member.self), leader = members.find(member => member.leader);
            if (self && leader && members.every(member => member.id)) {
                return { known: true, inParty: true, inLobby, online, members,
                    role: self.leader && has(frame, 'leader') ? 'leader' : !self.leader && !has(frame, 'leader') ? 'member' : 'unknown',
                    selfId: self.id, leaderId: leader.id, leaderName: leader.name,
                    pending: Boolean(frame.querySelector?.('[data-cancel]') || frame.querySelector?.('.pf-ready, .pf-wait')),
                    signature: `${self.id}|${leader.id}|${members.map(member => member.id).sort().join(',')}` };
            }
        }
        if (inLobby && online && frame && has(frame, 'hidden') && !rows.length) {
            return { known: true, inParty: false, inLobby: true, online: true, members: [], role: 'solo', signature: 'solo' };
        }
        const coop = game?.coop;
        if (!inLobby && coop && (coop.expected?.length > 0 || coop.mates?.size > 0 || coop.me > 0 && coop.host > 0 && !coop.alone)) {
            return { known: true, inParty: true, inLobby: false, online: false, members: [], role: 'combat', signature: 'combat' };
        }
        return { known: false, inParty: false, inLobby, online, members: [], role: 'unknown', signature: 'unknown' };
    }

    function partyDialogKind(title, text) {
        if (!['隊伍', '队伍', 'party', 'grupo'].includes(normalized(title))) return null;
        if (/想與隊伍一同出發|想与队伍一同出发|wants to set out with the party|quiere salir con el grupo|quer sair com o grupo/i.test(text)) return 'ready';
        if (/劇情只能單人遊玩|剧情只能单人游玩|stories are played solo|las historias se juegan en solitario|as histórias são jogadas sozinho/i.test(text)) return 'blocked';
        if (/並非隊伍中所有人|并非队伍中所有人|你無法與隊伍前往|你无法与队伍前往|not everyone in the party can enter|you can't go to that stage with the party|no todo el grupo puede entrar|no puedes ir a ese stage con el grupo|nem todo o grupo pode entrar|você não pode ir a essa fase com o grupo/i.test(text)) return 'blocked';
        return null;
    }

    function panelLayout(panel, viewport) {
        const margin = Math.min(8, viewport.width / 4, viewport.height / 4);
        const availableWidth = Math.max(1, viewport.width - margin * 2);
        const availableHeight = Math.max(1, viewport.height - margin * 2);
        const width = panel.minimized ? Math.min(240, availableWidth)
            : clamp(panel.width, Math.min(310, availableWidth), availableWidth);
        const height = panel.minimized ? Math.min(48, availableHeight)
            : clamp(panel.height, Math.min(250, availableHeight), availableHeight);
        return {
            x: clamp(panel.x ?? viewport.width - width - 12, margin, viewport.width - width - margin),
            y: clamp(panel.y ?? viewport.height - height - 12, margin, viewport.height - height - margin),
            width, height,
        };
    }

    function parseSkillRules(text) {
        return String(text).split(/[\n,，]+/).map(line => {
            const match = /^\s*(.*?)\s*(?:=\s*(\d+))?\s*$/.exec(line);
            return match && match[1] ? { name: normalized(match[1]), cap: match[2] ? Number(match[2]) : Infinity } : null;
        }).filter(Boolean);
    }

    function normalizeSkillProfile(profile = {}) {
        const strings = values => Array.isArray(values) ? [...new Set(values.filter(value => typeof value === 'string' && value))] : [];
        const order = strings(profile?.order), excluded = strings(profile?.excluded);
        // Keep unavailable entries outside the active order. Reconcile edits
        // into their remembered positions, so arrow buttons/focus only use
        // visible entries and a respec does not erase a saved priority or X.
        const active = new Set(order), previous = strings(profile?.history?.order ?? order);
        let next = 0;
        const remembered = previous.map(id => active.has(id) ? order[next++] : id);
        const historyOrder = [...new Set([...remembered, ...order.slice(next)])];
        const historyExcluded = [...new Set([
            ...strings(profile?.history?.excluded ?? excluded).filter(id => !active.has(id)), ...excluded,
        ])];
        return { order, excluded, history: { order: historyOrder, excluded: historyExcluded } };
    }

    function mergeSkillProfile(saved, catalog, legacy = '') {
        const profile = normalizeSkillProfile(saved);
        const ids = catalog.map(skill => skill.id);
        const prior = profile.history.order.length ? profile.history.order : parseSkillRules(legacy).flatMap(rule => {
            const match = catalog.find(skill => normalized(skill.id) === rule.name || normalized(skill.name) === rule.name);
            return match ? [match.id] : [];
        });
        const remembered = [...new Set([...prior, ...ids])];
        return normalizeSkillProfile({
            order: remembered.filter(id => ids.includes(id)),
            excluded: profile.history.excluded.filter(id => ids.includes(id)),
            history: { order: remembered, excluded: profile.history.excluded },
        });
    }

    function readTalentSkills(character, helpers) {
        const family = helpers.jobFamily ? helpers.jobFamily(character.job) : [character.job];
        const selected = [], learned = [], starts = [];
        for (const [id, value] of Object.entries(character.talents ?? {})) {
            const talent = helpers.talents?.[id], rank = Number(value);
            if (!talent || !family.includes(talent.job) || !Number.isFinite(rank) || rank <= 0) continue;
            const active = helpers.talentActive ? helpers.talentActive(talent, character.weaponType, character.shield)
                : (!talent.weapons || talent.weapons.includes(character.weaponType ?? '')) && (!talent.needsShield || character.shield);
            selected.push({ id, name: talent.name || id, rank, active: Boolean(active) });
            // The native loadout learns before checking equipment. The native
            // skill pool decides which learned definitions can become cards.
            if (talent.learn) learned.push(talent.learn);
            if (active && talent.start) starts.push(talent.start);
        }
        return { selected, learned: [...new Set(learned)], starts };
    }

    function talentSkillSources(character, helpers) {
        const family = helpers.jobFamily ? helpers.jobFamily(character.job) : [character.job];
        const learned = new Set(character.learned ?? []);
        const starts = new Set((character.starts ?? []).map(start => typeof start === 'string' ? start : start?.skill));
        const sources = new Map();
        for (const [talentId, talent] of Object.entries(helpers.talents ?? {})) {
            if (!family.includes(talent.job)) continue;
            const id = learned.has(talent.learn) ? talent.learn : starts.has(talent.start?.skill) ? talent.start.skill : null;
            if (!id) continue;
            // In town only the actually selected talent is a source; in a run
            // the native loadout is the authoritative snapshot of learned skills.
            if (character.talents && !(Number(character.talents[talentId]) > 0)) continue;
            const names = sources.get(id) || [];
            const label = `${talent.learn === id ? '天賦解鎖' : '開場技能'}・${talent.name || talentId}`;
            if (!names.includes(label)) names.push(label);
            sources.set(id, names);
        }
        return sources;
    }

    function townSkillStats(character, helpers) {
        if (!helpers.skillTransforms?.length || typeof helpers.createStats !== 'function') return null;
        const stats = helpers.createStats(helpers.classById(character.job));
        for (const selected of character.talentContext?.selected ?? []) {
            if (selected.active) helpers.talents[selected.id]?.stat?.(stats, selected.rank);
        }
        return stats;
    }

    function buildSkillCatalog(character, helpers, game = null, offered = []) {
        const definitions = helpers.skills;
        const owned = new Set([
            ...(game?.slots ?? []), ...(game?.weapons ?? []).map(weapon => weapon.id),
            ...Array.from(game?.passiveRank?.keys?.() ?? []), ...Array.from(game?.passives?.keys?.() ?? []),
        ]);
        const actual = new Set(offered.map(card => card?.id).filter(id => typeof id === 'string'));
        const starting = new Set((character.starts ?? []).map(start => typeof start === 'string' ? start : start?.skill));
        const pool = helpers.skillPool(character.job, character.learned);
        if (!Array.isArray(pool)) throw new Error('官方技能池格式已變更，請更新腳本');
        const ids = [...new Set([
            ...pool.map(skill => skill.id), ...starting,
            ...owned, ...actual,
        ])];
        const catalog = [], sources = talentSkillSources(character, helpers);
        const previewStats = game ? null : townSkillStats(character, helpers);
        for (const id of ids) {
            if (typeof id !== 'string' || !id || id === 'potion' || id === character.basicId || id.startsWith('atk_')) continue;
            const raw = definitions[id];
            let definition = raw;
            try { definition = game?.skillDef?.(id) || raw; } catch {}
            if (!game) for (const rule of helpers.skillTransforms ?? []) {
                if (previewStats?.[rule.flag] && rule.from.includes(id)) definition = definitions[rule.to] || definition;
            }
            if (!definition && !actual.has(id)) continue;
            // Match native freshChoices. Owned/offered skills stay valid, and
            // talent-granted starting skills bypass fresh-card equipment gates
            // just as the native constructor does (e.g. Light Strike).
            if (!owned.has(id) && !actual.has(id) && !starting.has(id) && raw
                && (raw.needsShield && !character.shield
                    || raw.weapons && !raw.weapons.includes(character.weaponType ?? ''))) continue;
            const icon = definition?.icon || raw?.icon || id;
            const changed = definition?.id && definition.id !== id;
            const detail = [...(changed ? [`技能變更・${raw?.name || id}`] : []), ...(sources.get(id) || [])];
            if (!pool.some(skill => skill.id === id) && !sources.has(id)) {
                if (actual.has(id)) detail.push('本局實際手牌');
                else if (owned.has(id)) detail.push('本局已取得');
            }
            catalog.push({ id, effectiveId: definition?.id || id, name: definition?.name || raw?.name || id,
                icon: helpers.assets.icons.get(icon) || new URL(`assets/icons/${encodeURIComponent(icon)}.png`, location.origin).href,
                detail: detail.join(' · '),
            });
        }
        const basicDefinition = definitions[character.basicId];
        const start = definitions[helpers.classById(character.job).start];
        const basicIcon = character.weaponItem && helpers.itemIcon ? helpers.itemIcon(character.weaponItem)
            : helpers.assets.icons.get(basicDefinition?.icon || start?.icon) || '';
        catalog.push({ id: '__basic__', name: '普通攻擊強化', icon: basicIcon });
        return catalog;
    }

    function moveSkill(profile, id, direction) {
        const index = profile.order.indexOf(id);
        if (index < 0 || ![-1, 1].includes(direction)) return false;
        const excluded = new Set(profile.excluded);
        let destination = index + direction;
        while (destination >= 0 && destination < profile.order.length
            && excluded.has(profile.order[destination]) !== excluded.has(id)) destination += direction;
        if (destination < 0 || destination >= profile.order.length) return false;
        [profile.order[index], profile.order[destination]] = [profile.order[destination], profile.order[index]];
        return true;
    }

    function cardQuality(card) {
        const value = card.quality ?? card.rarity;
        return Number.isInteger(value) ? clamp(value, 0, QUALITY_NAMES.length - 1) : 0;
    }

    function rerollIsLocked(game) {
        const maximum = game?.perksMax;
        if (!maximum || typeof maximum !== 'object') return false;
        const limit = Number(maximum.reroll ?? 0);
        return Number.isFinite(limit) && limit <= 0 && !(game.perksLeft?.reroll > 0);
    }

    function highestQualityChoice(cards, kind, owned, collectFirst = true) {
        const fresh = card => kind === 'chest' ? !owned?.get(card.slot) : Boolean(card.isNew && !card.id.startsWith('atk_'));
        const category = card => {
            const rank = CHEST_CATEGORY_ORDER.indexOf(card.slot);
            return rank < 0 ? Infinity : rank;
        };
        const choices = cards.flatMap((card, index) => card && typeof card === 'object'
            && (kind === 'chest' ? CHEST_CATEGORY_ORDER.includes(card.slot) && typeof card.item === 'string' : typeof card.id === 'string')
            ? [{ card, index }] : []);
        choices.sort((a, b) => cardQuality(b.card) - cardQuality(a.card)
            || (collectFirst ? Number(fresh(b.card)) - Number(fresh(a.card)) : 0)
            || (kind === 'chest' ? category(a.card) - category(b.card) : 0) || a.index - b.index);
        return choices[0]?.index ?? -1;
    }

    function canTankDamage(game, settings) {
        const hp = Number(game?.hp), maximum = Number(game?.stats?.maxHp);
        return Boolean(settings.tankThroughDanger && !game?.player?.dead && Number.isFinite(hp) && Number.isFinite(maximum)
            && hp > 0 && maximum > 0 && hp / maximum * 100 >= settings.tankHpPercent);
    }

    function valuablePickup(pickup) {
        return pickup?.kind === 'magnet';
    }

    function canTankChest(game, settings, pickup) {
        if (!canTankDamage(game, settings) || pickup?.kind !== 'chest' || pickup.dead || pickup.magnet || !point(pickup)
            || typeof game.chestCost !== 'function') return false;
        const cost = game.chestCost();
        return Number.isFinite(game.zeny) && Number.isFinite(cost) && cost >= 0 && game.zeny >= cost;
    }

    function ordinaryPickup(pickup) {
        return Boolean(pickup && typeof pickup.kind === 'string'
            && (pickup.kind === 'exp' || pickup.kind === 'zeny' || pickup.kind.startsWith('gem_')));
    }

    function openingFarmActive(game, settings) {
        if (!settings.openingFarm || !Number.isFinite(game?.time) || game.time < 0 || game.time >= settings.openingSeconds
            || !Number.isFinite(game.level) || typeof game.basicAttack !== 'string'
            || !game.weapons?.some(weapon => weapon.id === game.basicAttack)) return false;
        const attacks = game.weapons.filter(weapon => weapon.id !== game.basicAttack
            && !['buff', 'control'].includes(weapon.type) && !['heal', 'sanctuary'].includes(weapon.id));
        return game.level < 6 || attacks.length < 2;
    }

    function meatHealing(pickup, game) {
        const amount = Number(pickup?.value) * Number(game.stats?.potionMult);
        return pickup?.kind === 'meat' && !pickup.dead && point(pickup) && Number.isFinite(amount)
            ? Math.max(0, Math.min(amount, game.stats.maxHp - game.hp)) : 0;
    }

    // Read native cooldowns and live buffs only. Never cast a heal or count an
    // unavailable skill as extra HP. Recovery is permission to make a short
    // approach, not permission to lower the user's current-HP threshold.
    function routePickupContact(origin, path, target, radius) {
        let previous = origin, length = 0;
        for (const next of path) {
            const dx = next.x - previous.x, dy = next.y - previous.y, segment = Math.hypot(dx, dy);
            const t = segment ? clamp(((target.x - previous.x) * dx + (target.y - previous.y) * dy) / segment ** 2, 0, 1) : 0;
            const d2 = (previous.x + dx * t - target.x) ** 2 + (previous.y + dy * t - target.y) ** 2;
            if (d2 <= radius ** 2) {
                const enter = segment ? Math.max(0, t - Math.sqrt(Math.max(0, radius ** 2 - d2)) / segment) : 0;
                return { length: length + segment * enter, point: { x: previous.x + dx * enter, y: previous.y + dy * enter } };
            }
            length += segment; previous = next;
        }
        return null;
    }

    function recoveryOpportunity(game, settings, pickup, speed, fields = [], routePlan = null, credit = null) {
        if (!settings.recoveryLootRush || !canTankDamage(game, settings) || !point(pickup) || pickup.dead || pickup.magnet
            || !(ordinaryPickup(pickup) || ['meat', 'chest', 'magnet'].includes(pickup.kind)) || !Number.isFinite(speed) || speed <= 0) return null;
        const destination = { x: pickup.x, y: pickup.y + 20 };
        const extended = Boolean(routePlan?.path);
        if (distance(game.player, destination) > (extended ? Math.min(900, settings.resourceLootRadius) : 260)) return null;
        const route = extended ? routePlan.path : navigationPath(game.player, destination, game.walk);
        if (!route) return null;
        let length = 0, previous = game.player;
        for (const waypoint of route) { length += distance(previous, waypoint); previous = waypoint; }
        if (distance(previous, destination) > 30 || length > (extended ? 900 : 320) || length / speed > (extended ? 3 : 1.5)) return null;
        const travel = length / speed;
        const useful = Math.max(1, game.stats.maxHp * 0.01);
        if (credit?.until > game.time + Math.min(0.65, travel) + 0.1) {
            return { key: credit.key, name: '剛取得的實際回血' };
        }
        // A nearby meat drop only supports this route if approaching the goal
        // also brings it inside native attraction range. Do not borrow healing
        // from a pickup on the opposite side of the player or behind a wall.
        const attraction = Math.max(0, (Number(game.stats.pickupRadius) || 0) + Number(game.buffValue?.('pickup') || 0) - 10);
        for (const meat of game.pickups || []) {
            if (!meat || meat.dead || meat.magnet || meat.kind !== 'meat') continue;
            const at = { x: meat.x, y: meat.y + 20 };
            if (extended) {
                const contact = routePickupContact(game.player, route, at, attraction);
                const dangerAt = routePlan.firstDangerDistance;
                const afterDamage = routePlan.dangerous && contact && contact.length >= dangerAt;
                const amount = afterDamage ? Number(meat.value) * Number(game.stats.potionMult) : meatHealing(meat, game);
                if (!contact || !(amount >= useful) || contact.length > dangerAt + speed * 0.4
                    || game.walk?.lineClear && !game.walk.lineClear(contact.point.x, contact.point.y, at.x, at.y)) continue;
                return { key: meat, name: '沿途補血道具' };
            }
            if (meatHealing(meat, game) < useful) continue;
            if (meat !== pickup && (distance(destination, at) > attraction || distance(game.player, at) > 260)) continue;
            if (game.walk && !game.walk.lineClear(destination.x, destination.y, at.x, at.y)) continue;
            return { key: meat, name: '補血道具' };
        }
        if (typeof game.buffValue === 'function' && game.buffValue('kaahi') > 0
            && Number.isFinite(game.ext?.kaahiUntil) && game.ext.kaahiUntil > game.time + travel + 0.3) {
            return { key: 'kaahi', name: '凱阿希受擊回血' };
        }
        const regenBuff = game.buffs?.get?.('regen');
        const regen = (Number(game.stats.regen) || 0) + (Number(game.stats.regenMoving) || 0)
            + (regenBuff?.until > game.time + travel + 0.5 ? Number(regenBuff.value) || 0 : 0);
        if (Number.isFinite(regen) && regen >= useful) return { key: 'moving-regen', name: '已生效的移動回血' };
        if (Number.isFinite(game.regen5Left) && game.regen5Left >= 0 && game.regen5Left <= 0.6 && game.stats.regen5 >= useful) {
            return { key: 'periodic-regen', name: '即將觸發的週期回血' };
        }
        for (const field of fields) {
            if (field.weapon?.id !== 'sanctuary' || !game.weapons.includes(field.weapon) || !(field.until > game.time + travel + 0.5)) continue;
            if (distance(game.player, field) < field.radius - 12 && distance(destination, field) < field.radius - 12) {
                return { key: field, name: '光耀之堂恢復範圍' };
            }
        }
        for (const weapon of game.weapons || []) {
            if (!['heal', 'potion_pitcher', 'sanctuary', 'hp_recovery'].includes(weapon.id) || typeof weapon.finalCastTime !== 'function') continue;
            const readyIn = weapon.casting ? weapon.casting.left : Number(weapon.timer) + Number(weapon.finalCastTime(game));
            if (!Number.isFinite(readyIn) || readyIn > 0.6 || readyIn < -1
                || weapon.lowHp > 0 && game.hp > game.stats.maxHp * weapon.lowHp) continue;
            if (weapon.id === 'heal' && typeof weapon.eff === 'function'
                && weapon.eff('heal') * (1 + game.stats.matk / 150) >= useful) return { key: weapon, name: '即將可用的治癒術' };
            if (weapon.id === 'potion_pitcher' && game.hp <= game.stats.maxHp * 0.8 && game.stats.potionMult > 0) {
                return { key: weapon, name: '即將可用的藥水投擲' };
            }
            if (weapon.id === 'hp_recovery' && game.hp < game.stats.maxHp && typeof weapon.eff === 'function'
                && weapon.eff('heal') / 10 >= useful) return { key: weapon, name: '即將可用的 HP 回復力提升' };
            if (weapon.id === 'sanctuary' && typeof weapon.mod === 'function') {
                const radius = 130 * game.stats.areaMult * (1 + (weapon.mod(game).area || 0));
                if (Number.isFinite(radius) && distance(game.player, destination) < radius - 12) {
                    return { key: weapon, name: '即將可用的光耀之堂' };
                }
            }
        }
        return null;
    }

    function configuredSkillDecision(cards, profile, settings, gameTime, rerollsLeft, basicId) {
        const blocked = new Set(profile.excluded);
        const eligible = cards.map((card, index) => {
            const id = card.id === basicId || card.id.startsWith('atk_') ? '__basic__' : card.id;
            const priority = profile.order.indexOf(id);
            const allowed = priority >= 0 && !blocked.has(id);
            const isNew = Boolean(card.isNew && id !== '__basic__');
            const score = 10000 - priority * 100 + (Number(card.rarity) || 0) * 3;
            return { index, allowed, score, isNew, quality: cardQuality(card) };
        }).filter(entry => entry.allowed);
        if (eligible.length) {
            eligible.sort((a, b) => (settings.learnFirst ? Number(b.isNew) - Number(a.isNew) : 0)
                || (settings.qualityFirst ? b.quality - a.quality : 0) || b.score - a.score);
            return { action: 'pick', index: eligible[0].index };
        }
        if (rerollsLeft > 0) return { action: 'reroll' };
        return { action: gameTime < 120 ? 'restart' : 'wait' };
    }

    function pendingNativeOffer(game) {
        if (game?.state !== 'levelup' || !game.hand || typeof game.hand !== 'object') return null;
        const hand = game.hand;
        if (Array.isArray(hand.chest) && hand.chest.length && hand.chest.every(card => typeof card?.slot === 'string' && typeof card.item === 'string')) {
            return { kind: 'chest', cards: hand.chest };
        }
        if (Array.isArray(hand.level) && hand.level.length && hand.level.every(card => typeof card?.id === 'string')) {
            return { kind: 'skill', cards: hand.level };
        }
        return null;
    }

    function buildChestCatalog(itemDefinitions, skills, canDeify, itemIcon, game = null, offered = []) {
        const groups = Object.fromEntries(CHEST_SLOTS.map(slot => [slot.id, []]));
        const useless = game?.uselessItems?.() ?? new Set();
        for (const item of Object.values(itemDefinitions)) {
            if (!groups[item.slot] || typeof item.id !== 'string') continue;
            if (useless.has(item.id) && game?.runItems?.slots?.get(item.slot)?.item !== item.id
                && !offered.some(card => card?.slot === item.slot && card.item === item.id)) continue;
            let description = '';
            if (typeof item.text === 'function') {
                try {
                    const low = item.text(item.range?.[0] ?? 1), high = item.text(item.range?.[1] ?? item.range?.[0] ?? 1);
                    description = low === high ? low : `${low} ～ ${high}`;
                } catch { description = '依遊戲當下的道具說明'; }
            }
            groups[item.slot].push({
                id: item.id, name: item.name || item.id, icon: itemIcon(item) || '',
                detail: item.slot === 'deity' ? '屬性神祇' : '',
                description,
            });
        }
        const skillDeities = skills.filter(skill => skill.id !== '__basic__' && canDeify(skill.id)
            && (!skill.effectiveId || skill.effectiveId === skill.id) && !game?.coldClone?.(skill.id)).map(skill => ({
            id: skill.id, name: `${skill.name} 神祇`, icon: skill.icon,
            detail: '技能神祇', description: '本局已學會並攜帶此技能時，寶箱才會提供其神祇。',
        }));
        groups.deity = [...skillDeities, ...groups.deity];
        // Native ownership/hand are authoritative. An existing skill deity can
        // still be upgraded even when the skill no longer permits a new deity.
        const appendNative = (card, owned = false) => {
            const group = groups[card?.slot];
            if (!group || typeof card.item !== 'string' || group.some(item => item.id === card.item)) return;
            const skill = skills.find(skill => skill.id === card.item);
            group.push({ id: card.item, name: game?.runItemName?.(card.slot, card.item) || card.item,
                icon: skill?.icon || '', detail: owned ? '本局已持有' : '本局已出現',
                description: '已依遊戲原生寶箱選項同步，可調整順位。' });
        };
        for (const [slot, item] of game?.runItems?.slots ?? []) appendNative({ slot, item: item.item }, true);
        for (const card of offered) appendNative(card);
        return groups;
    }

    function chestCandidateRanks(cards, profiles, owned) {
        return cards.flatMap((card, index) => {
            const profile = profiles[card.slot];
            if (!profile || profile.excluded.includes(card.item)) return [];
            const rank = profile.order.indexOf(card.item);
            if (rank < 0) return [];
            const current = owned?.get(card.slot);
            if (current && current.item !== card.item && !profile.excluded.includes(current.item)) {
                const currentRank = profile.order.indexOf(current.item);
                if (currentRank >= 0 && rank >= currentRank) return [];
            }
            return [{ index, rank }];
        });
    }

    function configuredChestDecision(cards, profiles, owned, scores, rerollEnabled, rerollsLeft, qualityFirst = true, collectFirst = true) {
        const candidates = chestCandidateRanks(cards, profiles, owned);
        const score = index => Number.isFinite(scores[index]) ? scores[index] : -Infinity;
        const category = index => {
            const rank = CHEST_CATEGORY_ORDER.indexOf(cards[index].slot);
            return rank < 0 ? Infinity : rank;
        };
        const missingSlot = index => !owned?.get(cards[index].slot);
        candidates.sort((a, b) => (collectFirst ? Number(missingSlot(b.index)) - Number(missingSlot(a.index)) : 0)
            || category(a.index) - category(b.index)
            || (qualityFirst ? cardQuality(cards[b.index]) - cardQuality(cards[a.index]) : 0)
            || a.rank - b.rank || score(b.index) - score(a.index) || a.index - b.index);
        if (candidates.length) return { action: 'pick', index: candidates[0].index };
        return { action: rerollEnabled && rerollsLeft > 0 ? 'reroll' : 'wait' };
    }

    function eliminationChoicesExhausted(game, kind, cards) {
        // Missing counters are not proof of exhaustion. Focus cannot turn an
        // all-unwanted hand into a different hand, so it is not an escape here.
        if (!Number.isFinite(game?.perksMax?.reroll) || !Number.isFinite(game?.perksLeft?.reroll)
            || game.perksLeft.reroll < 0 || game.perksLeft.reroll > 0) return false;
        for (const action of ['reroll_card', 'banish']) {
            if (!(game.perksMax[action] > 0)) continue;
            if (!Number.isFinite(game.perksLeft[action]) || game.perksLeft[action] < 0) return false;
            if (game.perksLeft[action] > 0 && cards.some(card => nativeCardActions(game, kind, card).includes(action))) return false;
        }
        return true;
    }

    function exhaustedChoice(cards, kind, profiles, game, settings, scores = []) {
        if (!profiles || !['skill', 'chest'].includes(kind)) return -1;
        const owned = game.runItems?.slots;
        const category = card => CHEST_CATEGORY_ORDER.indexOf(card.slot);
        const permitted = (profile, id) => profile?.order?.includes(id) && !profile.excluded?.includes(id);
        const choices = cards.flatMap((card, index) => {
            if (!card || typeof card !== 'object') return [];
            if (kind === 'chest' ? typeof card.item !== 'string' || category(card) < 0 : typeof card.id !== 'string') return [];
            const current = kind === 'chest' ? owned?.get(card.slot) : null;
            const profile = kind === 'chest' ? profiles[card.slot] : profiles;
            const id = kind === 'chest' ? card.item : skillProfileId(card, game.basicAttack);
            // Preserve existing preferred items before chasing rarity. If every
            // card replaces something, sacrifice an already-unwanted item first,
            // then the lowest-priority category, leaving deities until last.
            const replacing = current && current.item !== card.item;
            const damage = kind === 'chest' ? !replacing ? 0 : !permitted(profile, current.item) ? 1
                : 2 + CHEST_CATEGORY_ORDER.length - category(card)
                : card.id === 'potion' || !card.isNew || id === '__basic__' ? 0 : 1;
            const rank = profile?.order.indexOf(id) ?? -1;
            return [{ index, card, damage, fresh: kind === 'chest' && !current,
                rank: rank < 0 ? 1e9 : rank, score: Number.isFinite(scores[index]) ? scores[index] : -Infinity }];
        });
        choices.sort((a, b) => a.damage - b.damage
            || (settings.learnFirst && kind === 'chest' ? Number(b.fresh) - Number(a.fresh) : 0)
            || cardQuality(b.card) - cardQuality(a.card)
            || (kind === 'chest' ? category(a.card) - category(b.card) : 0)
            || a.rank - b.rank || b.score - a.score || a.index - b.index);
        return choices[0]?.index ?? -1;
    }

    function skillProfileId(card, basicId) {
        return card.id === basicId || card.id.startsWith('atk_') ? '__basic__' : card.id;
    }

    function preferredIds(profile, limit) {
        return (profile?.order || []).filter(id => !profile.excluded.includes(id)).slice(0, limit);
    }

    // Order matches the native picker. Locked actions are omitted, exhausted
    // actions still occupy their button position. A new skill cannot reroll.
    function nativeCardActions(game, kind, card) {
        if (!card || !['skill', 'chest'].includes(kind) || kind === 'skill' && card.id === 'potion') return [];
        const actions = [];
        const canReroll = kind === 'chest' ? 'canRerollChestCard' : 'canRerollCard';
        if (game.perksMax?.reroll_card > 0 && typeof game[canReroll] === 'function' && game[canReroll](card)) actions.push('reroll_card');
        if (game.perksMax?.focus > 0) actions.push('focus');
        if (game.perksMax?.banish > 0) actions.push('banish');
        return actions;
    }

    function cardControlPlans(game, kind, cards, profiles, settings, decision, session) {
        if (!profiles || !session || settings.cardActionLimit <= 0) return [];
        // The preference budget limits optional quality/focus spending. It
        // must not strand an all-excluded hand while usable elimination perks
        // remain. Those operations are bounded by the game's real counters.
        const preferenceSteps = session.preferenceSteps ?? session.steps;
        if (decision.action === 'pick' && preferenceSteps >= settings.cardActionLimit) return [];
        const available = (action, index) => game.perksMax?.[action] > 0 && game.perksLeft?.[action] > 0
            && nativeCardActions(game, kind, cards[index]).includes(action);
        const idOf = card => kind === 'skill' ? skillProfileId(card, game.basicAttack) : card.item;
        const profileOf = card => kind === 'skill' ? profiles : profiles[card.slot];
        const preferred = card => preferredIds(profileOf(card), settings.focusTopCount).includes(idOf(card));
        const allowed = kind === 'skill' ? cards.flatMap((card, index) => {
            const id = idOf(card);
            return profiles.order.includes(id) && !profiles.excluded.includes(id)
                ? [{ index, rank: profiles.order.indexOf(id) }] : [];
        }) : chestCandidateRanks(cards, profiles, game.runItems?.slots);
        const category = card => kind === 'skill' ? 0 : CHEST_CATEGORY_ORDER.indexOf(card.slot);
        const plans = [];
        if (settings.autoFocus && !session.focusUsed) {
            const focused = kind === 'skill' ? game.focused : game.focusedItems;
            const candidates = allowed.filter(({ index }) => preferred(cards[index]) && available('focus', index)
                && !focused?.has(kind === 'skill' ? cards[index].id : cards[index].item));
            candidates.sort((a, b) => category(cards[a.index]) - category(cards[b.index]) || a.rank - b.rank
                || cardQuality(cards[b.index]) - cardQuality(cards[a.index]) || a.index - b.index);
            plans.push(...candidates.map(({ index }) => ({ action: 'focus', index })));
        }
        // Reserve full-deck rerolls for the existing no-eligible-choice flow.
        const wholeAvailable = game.perksLeft?.reroll > 0 && (kind === 'skill' || settings.chestReroll);
        if (wholeAvailable) return plans;
        if (decision.action === 'pick') {
            const index = decision.index, card = cards[index];
            const safeSameItem = kind === 'skill' || card.slot !== 'deity' && game.runItems?.slots.get(card.slot)?.item === card.item;
            if (settings.autoCardReroll && settings.qualityFirst && preferred(card) && safeSameItem
                && cardQuality(card) < settings.cardRerollMinQuality && available('reroll_card', index)) {
                plans.push({ action: 'reroll_card', index });
            }
        } else {
            // Chest rerolls retain the category. An empty ordinary category can
            // change item; a filled one normally keeps the held item instead.
            const rerolls = [], banishes = [];
            if (settings.autoCardReroll && kind === 'chest') for (let index = 0; index < cards.length; index++) {
                const card = cards[index], profile = profileOf(card);
                if (!game.runItems?.slots.get(card.slot)
                    && preferredIds(profile, Infinity).some(id => id !== card.item) && available('reroll_card', index)) {
                    rerolls.push({ action: 'reroll_card', index });
                }
            }
            if (settings.autoBanish) for (let index = 0; index < cards.length; index++) {
                // Banish lasts this run: permanently remove explicit ❌ only.
                if (profileOf(cards[index])?.excluded.includes(idOf(cards[index])) && available('banish', index)) {
                    banishes.push({ action: 'banish', index });
                }
            }
            const alreadyRerolled = plan => kind === 'chest' && session.chestRerolledSlots?.has(cards[plan.index].slot);
            // After an unsuccessful category reroll, try banish before spending
            // the entire choice budget rerolling other unwanted chest cards.
            plans.push(...banishes.filter(alreadyRerolled), ...rerolls.filter(plan => !alreadyRerolled(plan)),
                ...banishes.filter(plan => !alreadyRerolled(plan)), ...rerolls.filter(alreadyRerolled));
        }
        return plans;
    }

    function pickStage(rows, preference) {
        const available = rows.filter(row => row.unlocked);
        if (!available.length) return null;
        if (isLanternStage(preference)) return available.find(row => row.id === LANTERN_STAGE.id || isLanternStage(row.name)) ?? null;
        if (preference === 'last') return available[available.length - 1];
        if (preference === 'first') return available[0];
        return available.find(row => row.name === preference) ?? available[0];
    }

    function parseImports(source, entryUrl) {
        const bindings = new Map();
        const pattern = /import\s*\{([^}]+)\}\s*from\s*["']([^"']+)["']/g;
        for (const match of source.matchAll(pattern)) {
            const url = new URL(match[2], entryUrl).href;
            for (const specifier of match[1].split(',')) {
                const parts = specifier.trim().split(/\s+as\s+/);
                bindings.set(parts[1] ?? parts[0], { url, exported: parts[0] });
            }
        }
        return bindings;
    }

    function findRegistryBinding(source, entryUrl) {
        const match = /for\s*\(\s*const\s+\w+\s+of\s+([\w$]+)\.start\s*\)\s*\w+\(this\)/.exec(source);
        const binding = match && parseImports(source, entryUrl).get(match[1]);
        if (!binding) throw new Error('找不到目前版本的戰鬥入口');
        return binding;
    }

    function readSkillTransforms(source, skills) {
        // Read the native display relationship as data, without evaluating
        // downloaded source. Unknown formats leave in-run skillDef in charge.
        const clone = /coldClone\(([\w$]+)\)\{[^{}]*?\.([\w$]+)\)\s*&&\s*([\w$]+)\.includes\(\1\)\}/.exec(source);
        const display = /skillDef\(([\w$]+)\)\{return\s+[\w$]+\[this\.coldClone\(\1\)\?"([^"\n]+)":\1\]\}/.exec(source);
        if (!clone || !display || !skills[display[2]]) return [];
        const name = clone[3].replace(/\$/g, '\\$');
        const list = new RegExp(`(?:^|[^\\w$])${name}\\s*=\\s*(\\[[^\\]]{1,1000}\\])`).exec(source);
        if (!list) return [];
        try {
            const from = JSON.parse(list[1]);
            if (!Array.isArray(from) || !from.length || !from.every(id => typeof id === 'string' && skills[id])) return [];
            return [{ flag: clone[2], from: [...new Set(from)], to: display[2] }];
        } catch { return []; }
    }

    function resolveGameBindings(core, source, entryUrl, coreUrl) {
        // Main-bundle aliases change on every rebuild. Validate core exports and
        // use their actual structure/signature instead of those temporary names.
        const values = [...new Set(Object.values(core))];
        const functionIs = test => value => typeof value === 'function' && test(Function.prototype.toString.call(value));
        const choose = (label, hint, test) => {
            if (test(core[hint])) return core[hint];
            const matches = values.filter(test);
            if (matches.length !== 1) throw new Error(`無法辨識${label}介面（符合 ${matches.length} 個），請更新腳本`);
            return matches[0];
        };
        const imports = parseImports(source, entryUrl);
        const numberFrom = (local, label, low, high) => {
            const binding = imports.get(local);
            const value = binding?.url === coreUrl ? core[binding.exported] : undefined;
            if (typeof value !== 'number' || !Number.isFinite(value) || value < low || value > high) throw new Error(`無法辨識${label}倍率，請更新腳本`);
            return value;
        };
        const speed = /this\.classDef\.speed\s*\*\s*([\w$]+)/.exec(source);
        const levels = /([\w$]+)\.damageMult\*=1\+([\w$]+)\*([\w$]+),\1\.maxHp\*=1\+([\w$]+)\*\3/.exec(source);
        const helpers = {
            skills: choose('技能資料', 'g', value => !!value?.heal && value.heal.id === 'heal' && value.holy_light?.id === 'holy_light'),
            createStats: choose('基礎屬性', 'bZ', functionIs(text => text.includes('damageMult:1') && text.includes('pickupRadius:') && text.includes('maxHp:'))),
            applyRank: choose('職階屬性', 'c8', functionIs(text => text.includes('.powerMelee') && text.includes('.atkRanged') && text.includes('.basicExpBonus'))),
            finalizeStats: choose('屬性遞減', 'c9', functionIs(text => text.length < 400 && text.includes('.areaMult=') && text.includes('.reachMult=') && text.includes('.speedMult='))),
            classById: choose('職業', 'j', functionIs(text => text.length < 200 && text.includes('.find(') && text.includes('.id===') && text.includes('??'))),
            speedUnits: numberFrom(speed?.[1], '移動速度', 0.01, 20),
            levelDamage: numberFrom(levels?.[2], '等級傷害', 0, 1),
            levelHp: numberFrom(levels?.[4], '等級生命', 0, 1),
            storage: choose('角色儲存', 'bB', value => typeof value?.getItem === 'function' && typeof value.setItem === 'function' && typeof value.removeItem === 'function'),
            scopeKey: choose('角色帳號', 'bC', functionIs(text => text.length < 200 && text.includes('.startsWith(') && text.includes('.slice('))),
            assets: choose('圖示資料', 'aR', value => !!value?.icons && typeof value.icons.get === 'function' && typeof value.sheet === 'function'),
            skillPool: choose('職業技能池', 'er', functionIs(text => text.includes('.maxLevel') && text.includes('.flatMap(') && text.includes('.create') && text.includes('new Set'))),
            itemIcon: choose('道具圖示', 'cu', functionIs(text => text.length < 400 && text.includes('.manifest.items') && text.includes('.icon'))),
            displayClass: choose('職業名稱', 'h', functionIs(text => text.length < 200 && text.includes('.nameF') && text.includes('"f"'))),
            talents: choose('天賦資料', 'd', value => !!value && typeof value === 'object' && Object.values(value).filter(talent => typeof talent?.job === 'string' && Number.isFinite(talent.maxRank)).length > 20),
            jobFamily: choose('職業系譜', 'ca', functionIs(text => text.length < 220 && text.includes('.base?[') && text.includes('.base)') && text.includes('.id'))),
            equipmentDefinitions: choose('裝備資料', 'aS', value => value?.[1101]?.slot === 'weapon' && typeof value[1101].wtype === 'string'),
            itemDefinitions: choose('寶箱道具', 'cL', value => {
                if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
                const items = Object.values(value).filter(item => typeof item?.id === 'string' && CHEST_SLOTS.some(slot => slot.id === item.slot)
                    && typeof item.apply === 'function' && typeof item.text === 'function' && Array.isArray(item.range));
                return items.length >= 10 && new Set(items.map(item => item.slot)).size === CHEST_SLOTS.length;
            }),
            canDeify: choose('技能神祇', 'cA', functionIs(text => text.length < 220 && text.includes('.kind') && text.includes('"weapon"') && text.includes('"atk_"'))),
        };
        const characterStorageKey = /["'](ro-survivors\.characters\.v\d+)["']/.exec(source)?.[1];
        if (!characterStorageKey) throw new Error('無法辨識角色儲存格式，請更新腳本');
        const talentChecks = values.filter(functionIs(text => text.length < 250 && text.includes('.weapons.includes(')
            && text.includes('.needsShield') && !text.includes('.kind')));
        helpers.talentActive = talentChecks.length === 1 ? talentChecks[0] : null;
        helpers.skillTransforms = readSkillTransforms(source, helpers.skills);
        return { helpers, characterStorageKey };
    }

    function zoneContains(hazard, position, padding = 18) {
        const zone = hazard.zone;
        const dx = position.x - zone.x;
        const dy = position.y - zone.y;
        const radius = Math.max(zone.w, zone.h) / 2;
        if (!Number.isFinite(radius) || radius <= 0) return false;
        if (hazard.kind === 'rect') {
            const angle = zone.rotation || 0;
            const x = dx * Math.cos(angle) + dy * Math.sin(angle);
            const y = -dx * Math.sin(angle) + dy * Math.cos(angle);
            return Math.abs(x) < zone.w / 2 + padding && Math.abs(y) < zone.h / 2 + padding;
        }
        const length = Math.hypot(dx, dy);
        if (length >= radius + padding) return false;
        if (hazard.kind === 'ring') return length > radius * hazard.parameter - padding;
        if (hazard.kind === 'cone') {
            const angle = Math.atan2(dy, dx) - (zone.rotation || 0);
            const wrapped = Math.atan2(Math.sin(angle), Math.cos(angle));
            return length < padding || Math.abs(wrapped) <= hazard.parameter + Math.asin(Math.min(1, padding / length));
        }
        return true;
    }

    function threatRisk(position, timeAhead, threats, zones, arrows) {
        let risk = 0;
        for (const threat of threats) {
            const prediction = Number.isFinite(threat.predictionHorizon) ? Math.min(timeAhead, threat.predictionHorizon) : timeAhead;
            const x = threat.x + threat.vx * prediction;
            const y = threat.y + threat.vy * prediction;
            const separation = Math.hypot(position.x - x, position.y - y);
            const overlap = Math.max(0, 1 - separation / threat.radius);
            risk += overlap * overlap * 35;
            if (separation < threat.contact) risk += 50 * (1 - separation / threat.contact);
        }
        for (const hazard of zones) if (zoneContains(hazard, position)) risk += 140;
        for (const arrow of arrows) {
            const x = arrow.fx.anchor.x + arrow.vx * timeAhead;
            const y = arrow.fx.anchor.y + arrow.vy * timeAhead;
            const separation = Math.hypot(position.x - x, position.y - y);
            if (separation < 50) risk += 100 * (1 - separation / 50);
        }
        return risk;
    }

    function movingArrowRisk(origin, target, duration, arrows) {
        let risk = 0;
        for (const arrow of arrows) {
            const dx = origin.x - arrow.fx.anchor.x;
            const dy = origin.y - arrow.fx.anchor.y;
            const vx = (target.x - origin.x) / duration - arrow.vx;
            const vy = (target.y - origin.y) / duration - arrow.vy;
            const speedSquared = vx * vx + vy * vy;
            const at = speedSquared ? clamp(-(dx * vx + dy * vy) / speedSquared, 0, duration) : 0;
            const separation = Math.hypot(dx + vx * at, dy + vy * at);
            if (separation < 50) risk += 150 * (1 - separation / 50);
        }
        return risk;
    }

    function friendlyAreaPoint(origin, area) {
        const length = distance(origin, area);
        const inner = Math.max(8, area.radius - Math.min(24, area.radius * 0.2));
        if (length <= inner) return null;
        return { x: area.x + (origin.x - area.x) / length * inner * 0.95,
            y: area.y + (origin.y - area.y) / length * inner * 0.95 };
    }

    function selectFriendlyArea(origin, areas, maxTravel = 260) {
        return areas.filter(area => point(area) && Number.isFinite(area.radius) && area.radius >= 24
            && Math.max(0, distance(origin, area) - area.radius) <= maxTravel)
            .sort((a, b) => {
                const cost = area => Math.max(0, distance(origin, area) - area.radius) - (distance(origin, area) <= area.radius ? 1000 : 0);
                return cost(a) - cost(b);
            })[0] || null;
    }

    // Moonlight Flower's bell bypasses zoneDecal. The native 3D actor carries
    // the live safe radius, seal, charge and toll state in world coordinates.
    function readBellShelters(game) {
        const actors = game?.world3d?.cylinders;
        if (!Array.isArray(actors)) return [];
        return actors.flatMap(actor => {
            const safeR = actor?.groundMat?.uniforms?.safeR?.value;
            const position = actor?.mesh?.position;
            if (!Number.isFinite(safeR) || safeR <= 24 || safeR > 2000
                || !Number.isFinite(position?.x) || !Number.isFinite(position?.z)
                || typeof actor.toll !== 'function' || typeof actor.finish !== 'function'
                || typeof actor.sealed !== 'boolean' || !Number.isFinite(actor.charge)
                || !Number.isFinite(actor.waveAge) || actor.waveAge >= 0
                || !Number.isFinite(actor.out) || actor.out >= 0) return [];
            // Native impact checks center distance < safeR - 4, not the
            // wider glowing rim. Keep an additional movement margin below.
            return [{ x: position.x, y: position.z, radius: safeR - 4,
                sealed: actor.sealed, charge: clamp(actor.charge, 0, 1), actor }];
        });
    }

    function selectBellShelter(origin, bells) {
        return [...bells].sort((a, b) => Number(a.sealed) - Number(b.sealed)
            || Number(distance(origin, b) < b.radius) - Number(distance(origin, a) < a.radius)
            || distance(origin, a) - distance(origin, b))[0] || null;
    }

    function bellDestination(origin, bell, guardian = null) {
        if (bell.sealed && guardian) {
            const length = distance(guardian, bell) || 1;
            const offset = Math.min(82, length);
            // Engage from the bell-facing side, shortening the return after
            // the native guard kill opens the seal. Attacks remain automatic.
            return { x: guardian.x + (bell.x - guardian.x) / length * offset,
                y: guardian.y + (bell.y - guardian.y) / length * offset };
        }
        const length = distance(origin, bell);
        if (length <= bell.radius - 18) return null;
        const inner = Math.min(80, bell.radius * 0.55);
        return { x: bell.x + (origin.x - bell.x) / length * inner,
            y: bell.y + (origin.y - bell.y) / length * inner };
    }

    function bellRoute(origin, destination, bell, bounds, walk) {
        if (!destination) return { waypoint: null, blocked: false };
        const candidates = [destination, { x: bell.x, y: bell.y }];
        for (let i = 0; i < 8; i++) {
            const angle = i * Math.PI / 4, radius = Math.min(96, bell.radius - 24);
            candidates.push({ x: bell.x + Math.cos(angle) * radius, y: bell.y + Math.sin(angle) * radius });
        }
        const confined = !bell.sealed && distance(origin, bell) < bell.radius;
        const limit = Math.max(bell.radius - 6, distance(origin, bell));
        let best = null;
        for (const candidate of candidates) {
            const coordinates = walk?.nearestWalkable ? walk.nearestWalkable(candidate.x, candidate.y) : [candidate.x, candidate.y];
            const target = { x: coordinates[0], y: coordinates[1] };
            if (!point(target) || target.x < bounds.x0 || target.x > bounds.x1 || target.y < bounds.y0 || target.y > bounds.y1
                || !bell.sealed && distance(target, bell) > bell.radius - 12
                || walk?.walkable && !walk.walkable(target.x, target.y)) continue;
            const path = walk?.pathTo ? walk.pathTo(origin.x, origin.y, target.x, target.y)
                : !walk?.lineClear || walk.lineClear(origin.x, origin.y, target.x, target.y) ? [target] : null;
            if (!Array.isArray(path) || !path.length || path.some(p => !point(p) || confined && distance(p, bell) > limit + 1e-6)) continue;
            let length = 0, previous = origin;
            for (const p of path) { length += distance(previous, p); previous = p; }
            const cost = length + distance(target, destination) * (bell.sealed ? 4 : 0.25);
            if (!best || cost < best.cost) best = { cost, waypoint: path.find(p => distance(p, origin) > 8) || null, blocked: false };
        }
        return best || { waypoint: null, blocked: true };
    }

    function navigationContext(speed, threats, bounds, walk, settings) {
        return { avoidCorners: Boolean(settings.avoidCorners), radius: clamp(speed * 1.2, 150, 280),
            speed, threats, flow: threats.map(enemy => ({ enemy, closing: Math.hypot(enemy.vx || 0, enemy.vy || 0) })),
            bounds, walk, settings, terrain: new Map() };
    }

    function terrainSpace(position, context) {
        const { bounds, walk, radius } = context;
        const key = `${Math.round(position.x / 12)}:${Math.round(position.y / 12)}`;
        if (context.terrain.has(key)) return context.terrain.get(key);
        const rays = [];
        let reachSum = 0;
        for (let i = 0; i < 16; i++) {
            const angle = i * Math.PI / 8, dx = Math.cos(angle), dy = Math.sin(angle);
            let reach = 0;
            for (const fraction of [1 / 3, 2 / 3, 1]) {
                const x = position.x + dx * radius * fraction, y = position.y + dy * radius * fraction;
                if (x < bounds.x0 + 16 || x > bounds.x1 - 16 || y < bounds.y0 + 16 || y > bounds.y1 - 16
                    || walk?.walkable && !walk.walkable(x, y)
                    || walk?.lineClear && !walk.lineClear(position.x, position.y, x, y)) break;
                reach = radius * fraction;
            }
            reachSum += reach;
            rays.push({ dx, dy, reach });
        }
        let arc = 0, run = 0;
        for (let i = 0; i < 32; i++) {
            run = rays[i % 16].reach >= radius * 0.9 ? Math.min(16, run + 1) : 0;
            arc = Math.max(arc, run);
        }
        const result = { rays, openness: reachSum / (16 * radius), arc: arc / 16 };
        context.terrain.set(key, result);
        return result;
    }

    function crowdPressure(position, threats, horizon = 2) {
        let pressure = 0;
        for (const enemy of threats) {
            const closing = Math.hypot(enemy.vx || 0, enemy.vy || 0) * horizon;
            const gap = Math.max(0, distance(position, enemy) - closing - (enemy.contact || 30));
            pressure += Math.pow(Math.max(0, 1 - gap / 260), 2);
        }
        return pressure;
    }

    function navigationRisk(position, context) {
        const space = terrainSpace(position, context);
        const pressure = crowdPressure(position, context.threats);
        let free = 0;
        for (const ray of space.rays) {
            if (ray.reach < context.radius * 0.65) continue;
            let blocked = 0;
            for (const { enemy, closing } of context.flow) {
                const dx = enemy.x - position.x, dy = enemy.y - position.y;
                const along = dx * ray.dx + dy * ray.dy, lateral = Math.abs(dx * ray.dy - dy * ray.dx);
                if (along < -(enemy.contact || 30) || along > ray.reach + closing * 1.2) continue;
                const width = (enemy.contact || 30) + 55 + Math.min(60, closing * 0.3);
                blocked += Math.max(0, 1 - lateral / width)
                    * Math.max(0, 1 - Math.max(0, along - ray.reach) / Math.max(80, closing * 1.2));
            }
            if (blocked < 0.85) free++;
        }
        const weight = Math.min(4, pressure);
        const cost = (1 - space.openness) * (1 + weight * 3)
            + (1 - space.arc) * weight + (1 - free / 16) * weight * 2 + Math.min(6, pressure) * 0.6;
        return { space, pressure, free, cost };
    }

    function navigationPath(origin, target, walk) {
        const path = walk?.pathTo ? walk.pathTo(origin.x, origin.y, target.x, target.y)
            : !walk?.lineClear || walk.lineClear(origin.x, origin.y, target.x, target.y) ? [target] : null;
        return Array.isArray(path) && path.length && path.every(point) ? path : null;
    }

    function findRetreatRoute(origin, speed, threats, zones, arrows, bounds, walk, settings, context) {
        const initial = navigationRisk(origin, context), candidates = [], seen = new Set();
        const reach = clamp(speed * 2.6, 280, 650);
        for (const fraction of [0.45, 0.75, 1]) for (let i = 0; i < 16; i++) {
            const angle = i * Math.PI / 8;
            let target = { x: clamp(origin.x + Math.cos(angle) * reach * fraction, bounds.x0 + 24, bounds.x1 - 24),
                y: clamp(origin.y + Math.sin(angle) * reach * fraction, bounds.y0 + 24, bounds.y1 - 24) };
            if (walk?.nearestWalkable) { const xy = walk.nearestWalkable(target.x, target.y); target = { x: xy[0], y: xy[1] }; }
            const key = `${Math.round(target.x / 24)}:${Math.round(target.y / 24)}`;
            if (!point(target) || target.x < bounds.x0 || target.x > bounds.x1 || target.y < bounds.y0 || target.y > bounds.y1
                || seen.has(key) || distance(origin, target) < 60 || walk?.walkable && !walk.walkable(target.x, target.y)
                || walk?.reachable && !walk.reachable(target.x, target.y)) continue;
            seen.add(key);
            const safety = navigationRisk(target, context);
            // Fewer enemies must never make a deeper corner look like an
            // escape. Require at least the current amount of traversable room.
            if (safety.space.openness < initial.space.openness - 0.02) continue;
            if (safety.space.openness < initial.space.openness + 0.06 && safety.free <= initial.free + 1
                && !(safety.space.openness >= 0.75 && safety.pressure < initial.pressure - 0.4)) continue;
            const risk = threatRisk(target, 0.8, threats, zones, arrows);
            candidates.push({ target, score: safety.cost * 3 + risk * 0.5 + distance(origin, target) / reach });
        }
        candidates.sort((a, b) => a.score - b.score);
        let best = null;
        for (const candidate of candidates.slice(0, 8)) {
            const path = navigationPath(origin, candidate.target, walk);
            if (!path) continue;
            let length = 0, previous = origin, routeRisk = 0;
            for (const p of path) {
                const segment = distance(previous, p), samples = clamp(Math.ceil(segment / 80), 1, 8);
                for (let step = 1; step <= samples; step++) {
                    const fraction = step / samples;
                    const sample = { x: previous.x + (p.x - previous.x) * fraction, y: previous.y + (p.y - previous.y) * fraction };
                    routeRisk += threatRisk(sample, Math.min(2, (length + segment * fraction) / speed), threats, zones, arrows);
                }
                length += segment;
                previous = p;
            }
            if (length > reach * 3.5) continue;
            const score = candidate.score + length / reach + routeRisk * 0.25;
            if (!best || score < best.score) best = { destination: candidate.target, path, score };
        }
        return best;
    }

    function planMotion(origin, goal, speed, threats, zones, arrows, bounds, walk, settings, friendlyArea = null, allowDamage = false, containment = null, navigation = null) {
        const currentRisk = threatRisk(origin, 0, threats, zones, arrows);
        const soonRisk = threatRisk(origin, settings.lookahead, threats, zones, arrows);
        const danger = Math.max(currentRisk, soonRisk, movingArrowRisk(origin, origin, settings.lookahead, arrows)) > 0.3;
        if (!danger && !goal) return { point: null, risk: currentRisk, danger: false };
        const nav = settings.avoidCorners && threats.length && !containment && navigation?.avoidCorners !== false
            ? navigation || navigationContext(speed, threats, bounds, walk, settings) : null;
        const horizon = settings.lookahead;
        const directions = [{ x: 0, y: 0 }];
        if (goal && distance(origin, goal) > 1) {
            const length = distance(origin, goal);
            directions.push({ x: (goal.x - origin.x) / length, y: (goal.y - origin.y) / length });
        }
        for (let index = 0; index < 24; index += 1) {
            const angle = index * Math.PI / 12;
            directions.push({ x: Math.cos(angle), y: Math.sin(angle) });
        }
        let best = null;
        for (const direction of directions) {
            const moving = direction.x !== 0 || direction.y !== 0;
            let reach = goal && (!danger || allowDamage) ? Math.min(speed * horizon, distance(origin, goal)) : speed * horizon;
            // Keep opening dodges close enough to continue basic attacks.
            // Warning/projectile prediction still uses the full horizon below.
            if (navigation?.openingFarm && danger && !allowDamage && !zones.length && !arrows.length) reach = Math.min(reach, Math.max(35, speed * 0.22));
            const target = {
                x: clamp(origin.x + direction.x * reach, bounds.x0 + 2, bounds.x1 - 2),
                y: clamp(origin.y + direction.y * reach, bounds.y0 + 2, bounds.y1 - 2),
            };
            if (containment && distance(origin, containment) < containment.triggerRadius
                && distance(target, containment) > Math.max(containment.radius, distance(origin, containment)) + 1e-6) continue;
            let risk = 0;
            let blocked = false;
            for (const fraction of [0.2, 0.5, 0.8, 1]) {
                const sample = { x: origin.x + (target.x - origin.x) * fraction, y: origin.y + (target.y - origin.y) * fraction };
                if (walk && !walk.walkable(sample.x, sample.y)) { blocked = true; break; }
                risk += threatRisk(sample, horizon * fraction, threats, zones, arrows);
            }
            if (blocked || moving && distance(origin, target) < 3) continue;
            if (walk && !walk.lineClear(origin.x, origin.y, target.x, target.y)) continue;
            risk += movingArrowRisk(origin, target, horizon, arrows);
            const goalCost = goal ? distance(target, goal) / Math.max(8, Math.min(speed * horizon, distance(origin, goal))) : 0;
            // Normal travel prioritizes avoiding damage. Explicit tank mode trades
            // some attack risk for progress, while retaining terrain checks above.
            const fieldCost = friendlyArea ? 0.5 * Math.min(3, Math.max(0, distance(target, friendlyArea)
                - Math.max(8, friendlyArea.radius - 16)) / Math.max(30, friendlyArea.radius)) : 0;
            const futureCost = nav ? navigationRisk(target, nav).cost : 0;
            const score = allowDamage ? Math.log1p(risk) * 0.6 + goalCost * 8 + futureCost * 2 + (moving ? 0.08 : 0)
                : risk * 100 + goalCost * (nav?.retreat ? 6 : 1) + fieldCost + futureCost * (nav?.retreat ? 1 : 3) + (moving ? 0.15 : 0);
            if (!best || score < best.score) best = { point: moving ? target : null, risk, score, danger };
        }
        return best ?? { point: null, risk: currentRisk, danger };
    }

    function findEscapePoint(origin, speed, threats, zones, arrows, bounds, walk, settings) {
        const reach = Math.max(120, speed * 1.5);
        const navigation = settings.avoidCorners ? navigationContext(speed, threats, bounds, walk, settings) : null;
        const currentRoom = navigation ? terrainSpace(origin, navigation).openness : 0;
        const candidates = [];
        for (let index = 0; index < 24; index += 1) {
            const angle = index * Math.PI / 12;
            const target = { x: clamp(origin.x + Math.cos(angle) * reach, bounds.x0 + 2, bounds.x1 - 2),
                y: clamp(origin.y + Math.sin(angle) * reach, bounds.y0 + 2, bounds.y1 - 2) };
            if (distance(origin, target) < 30 || walk && (!walk.walkable(target.x, target.y)
                || !walk.lineClear(origin.x, origin.y, target.x, target.y))) continue;
            const safety = navigation ? navigationRisk(target, navigation) : null;
            const score = threatRisk(target, settings.lookahead, threats, zones, arrows) * 10 - distance(origin, target) / reach
                + (safety ? safety.cost * 12 : 0);
            candidates.push({ point: target, score, room: safety?.space.openness ?? 1 });
        }
        const roomToLeave = navigation ? candidates.filter(candidate => candidate.room >= currentRoom - 0.02) : candidates;
        return (roomToLeave.length ? roomToLeave : candidates).sort((a, b) => a.score - b.score)[0]?.point || null;
    }

    function chestBudget(game) {
        const cost = typeof game?.chestCost === 'function' ? Number(game.chestCost()) : NaN;
        return Number.isFinite(cost) && cost >= 0 && Number.isFinite(game.zeny)
            ? { cost, shortfall: Math.max(0, cost - game.zeny) } : null;
    }

    function segmentDistanceSquared(position, start, end) {
        const dx = end.x - start.x, dy = end.y - start.y;
        const length = dx * dx + dy * dy;
        const t = length ? clamp(((position.x - start.x) * dx + (position.y - start.y) * dy) / length, 0, 1) : 0;
        return (position.x - start.x - dx * t) ** 2 + (position.y - start.y - dy * t) ** 2;
    }

    function safeResourceRoute(game, pickup, context, radius) {
        const { speed, threats, zones, arrows } = context;
        let target = { x: pickup.x, y: pickup.y + 20 };
        if (game.walk?.nearestWalkable) {
            const xy = game.walk.nearestWalkable(target.x, target.y);
            const nearest = { x: xy[0], y: xy[1] };
            if (!point(nearest) || distance(nearest, target) > radius) return null;
            target = nearest;
        }
        if (game.walk?.reachable && !game.walk.reachable(target.x, target.y)) return null;
        const path = navigationPath(game.player, target, game.walk);
        if (!path) return null;
        let previous = game.player, length = 0, dangerous = false, firstDangerDistance = Infinity;
        const markDanger = at => {
            if (!context.allowRecovery) return false;
            dangerous = true; firstDangerDistance = Math.min(firstDangerDistance, at); return true;
        };
        if (Math.max(threatRisk(game.player, 0, threats, zones, arrows),
            threatRisk(game.player, context.lookahead, threats, zones, arrows),
            movingArrowRisk(game.player, game.player, context.lookahead, arrows)) > 0.3 && !markDanger(0)) return null;
        for (const next of path) {
            const segment = distance(previous, next);
            if (segment < 1e-6) { previous = next; continue; }
            const duration = segment / speed;
            const movingArrows = arrows.map(arrow => ({ ...arrow,
                fx: { anchor: { x: arrow.fx.anchor.x + arrow.vx * length / speed,
                    y: arrow.fx.anchor.y + arrow.vy * length / speed } } }));
            if (game.walk?.lineClear && !game.walk.lineClear(previous.x, previous.y, next.x, next.y)) return null;
            if (movingArrowRisk(previous, next, duration, movingArrows) > 0.3 && !markDanger(length)) return null;
            const steps = Math.max(1, Math.ceil(segment / 30));
            for (let i = 1; i <= steps; i++) {
                const fraction = i / steps;
                const sample = { x: previous.x + (next.x - previous.x) * fraction,
                    y: previous.y + (next.y - previous.y) * fraction };
                const bounds = game.bounds;
                if (bounds && (sample.x < bounds.x0 + 2 || sample.x > bounds.x1 - 2 || sample.y < bounds.y0 + 2 || sample.y > bounds.y1 - 2)
                    || game.walk?.walkable && !game.walk.walkable(sample.x, sample.y)) return null;
                if ((threatRisk(sample, 0, threats, zones, []) > 0.3
                    || threatRisk(sample, Math.min(2, (length + segment * fraction) / speed + context.lookahead), threats, zones, arrows) > 0.3)
                    && !markDanger(length + segment * fraction)) return null;
            }
            length += segment;
            if (length > context.radius * 1.5) return null;
            previous = next;
        }
        // A nearest-walkable point/path must still lead into native absorption
        // range. A path that stops on the wrong side of a wall earns no yield.
        const foot = { x: pickup.x, y: pickup.y + 20 };
        if (distance(previous, foot) > radius) return null;
        return { path, length, dangerous, firstDangerDistance,
            duration: Math.max(0.3, Math.max(0, length - radius) / speed + 0.2) };
    }

    function resourceFarmPlan(game, settings, pickups, context, currentGoal = null) {
        if (!settings.resourceFarm || !(settings.resourceLootRadius > 0) || !context || !(context.speed > 0)) return null;
        const radius = settings.resourceLootRadius;
        // Opening melee prediction is deliberately shorter. Resource trips use
        // full enemy forecasts so a distant coin cannot lure us through a mob.
        const threats = context.threats.map(threat => ({ ...threat, predictionHorizon: undefined }));
        const routeContext = { ...context, threats, radius, lookahead: settings.lookahead, allowRecovery: canTankDamage(game, settings) };
        if (Math.max(threatRisk(game.player, 0, threats, context.zones, context.arrows),
            threatRisk(game.player, settings.lookahead, threats, context.zones, context.arrows),
            movingArrowRisk(game.player, game.player, settings.lookahead, context.arrows)) > 0.3 && !routeContext.allowRecovery) return null;
        const absorption = Number(game.stats?.pickupRadius) + Number(game.buffValue?.('pickup') || 0);
        const pickupRadius = clamp(Number.isFinite(absorption) ? absorption - 2 : 38, 18, 240);
        const cellSize = Math.max(96, pickupRadius * 2), grid = new Map();
        const budget = chestBudget(game), shortfall = budget?.shortfall || 0;
        const chests = pickups.filter(pickup => pickup.kind === 'chest' && !pickup.dead && !pickup.magnet
            && distance(game.player, { x: pickup.x, y: pickup.y + 20 }) <= settings.specialLootRadius);
        for (const pickup of pickups) {
            if (!ordinaryPickup(pickup) || pickup.dead || pickup.magnet) continue;
            const foot = { x: pickup.x, y: pickup.y + 20 }, length = distance(game.player, foot);
            const value = pickup.value === undefined ? 1 : Number(pickup.value);
            if (length > radius || !Number.isFinite(value) || value <= 0) continue;
            const gx = Math.floor(foot.x / cellSize), gy = Math.floor(foot.y / cellSize), key = `${gx}:${gy}`;
            if (!grid.has(key)) grid.set(key, { gx, gy, items: [], coins: 0, exp: 0, nearest: {} });
            const cell = grid.get(key), kind = pickup.kind === 'zeny' ? 'coins' : 'exp';
            const item = { pickup, foot, length, value, kind };
            cell.items.push(item); cell[kind] += value;
            if (!cell.nearest[kind] || length < cell.nearest[kind].length) cell.nearest[kind] = item;
            if (pickup === currentGoal) cell.current = item;
        }
        const candidates = [];
        for (const cell of grid.values()) {
            let coins = 0, exp = 0;
            for (let x = cell.gx - 1; x <= cell.gx + 1; x++) for (let y = cell.gy - 1; y <= cell.gy + 1; y++) {
                const nearby = grid.get(`${x}:${y}`); if (nearby) { coins += nearby.coins; exp += nearby.exp; }
            }
            for (const item of new Set([...Object.values(cell.nearest), cell.current].filter(Boolean))) {
                const seconds = Math.max(0.3, item.length / context.speed);
                const estimate = shortfall > 0 && coins > 0 ? 1e6 + Math.min(shortfall, coins) / seconds : (coins + exp) / seconds;
                candidates.push({ item, estimate });
            }
        }
        candidates.sort((a, b) => b.estimate - a.estimate);
        // Bound native path searches even on a floor covered in thousands of
        // gems. Include nearby alternatives as well as valuable dense clusters.
        const shortlist = new Set(candidates.slice(0, 24).map(candidate => candidate.item));
        for (const candidate of [...candidates].sort((a, b) => a.item.length - b.item.length).slice(0, 8)) shortlist.add(candidate.item);
        let best = null;
        for (const item of shortlist) {
            const route = safeResourceRoute(game, item.pickup, routeContext, pickupRadius);
            if (!route) continue;
            const recovery = route.dangerous ? recoveryOpportunity(game, settings, item.pickup, context.speed,
                context.recoveryFields, route, context.recoveryCredit) : null;
            if (route.dangerous && !recovery) continue;
            let coins = 0, exp = 0, previous = game.player;
            const found = new Set();
            for (const next of route.path) {
                const steps = Math.max(1, Math.ceil(distance(previous, next) / cellSize));
                for (let i = 0; i <= steps; i++) {
                    const sample = { x: previous.x + (next.x - previous.x) * i / steps,
                        y: previous.y + (next.y - previous.y) * i / steps };
                    const gx = Math.floor(sample.x / cellSize), gy = Math.floor(sample.y / cellSize);
                    for (let x = gx - 1; x <= gx + 1; x++) for (let y = gy - 1; y <= gy + 1; y++) {
                        for (const resource of grid.get(`${x}:${y}`)?.items || []) {
                            if (found.has(resource) || segmentDistanceSquared(resource.foot, previous, next) > pickupRadius ** 2) continue;
                            found.add(resource);
                            if (resource.kind === 'coins') coins += resource.value; else exp += resource.value;
                        }
                    }
                }
                previous = next;
            }
            const funding = shortfall > 0 && coins > 0;
            // If this trip can pay for a box, include the next leg's estimated
            // travel. Otherwise an opposite-direction coin can look faster
            // while delaying the actual chest purchase.
            const chestTravel = funding && coins >= shortfall && chests.length
                ? Math.min(...chests.map(chest => Math.max(0, distance(route.path.at(-1),
                    { x: chest.x, y: chest.y + 20 }) - 33))) / context.speed : 0;
            const rate = (funding ? Math.min(shortfall, coins) : coins + exp) / (route.duration + chestTravel);
            if (!(rate > 0)) continue;
            const stableRate = rate * (item.pickup === currentGoal ? 1.03 : 1);
            const score = (funding ? 700 : 400) + 180 * stableRate / (stableRate + 20);
            if (!best || score > best.score) best = { pickup: item.pickup, score, funding, rate, coins, exp, budget, route, recovery };
        }
        return best;
    }

    function pickupScore(pickup, game, settings, opening = false) {
        // Equipment/cards/eggs and purple assignment markers settle at run
        // end. Only resources, healing, magnets and chests are travel goals.
        if (pickup.dead || pickup.magnet || ['mystery', 'loot', 'card', 'egg'].includes(pickup.kind) || !point(pickup)) return -Infinity;
        const length = distance(game.player, { x: pickup.x, y: pickup.y + 20 });
        // A magnet still vacuums coins and experience; settled rewards do not
        // participate in the travel priority tiers.
        const globalPriority = pickup.kind === 'magnet' ? 4 : 0;
        const special = !['exp', 'zeny'].includes(pickup.kind) && !pickup.kind.startsWith('gem_');
        if (!globalPriority && length > (special ? settings.specialLootRadius : opening ? settings.openingLootRadius : settings.normalLootRadius)) return -Infinity;
        const health = game.hp / game.stats.maxHp;
        const distanceCost = 100 * length / (length + 200);
        if (globalPriority) return globalPriority * 1000 - distanceCost;
        if (pickup.kind === 'chest' && game.zeny < game.chestCost()) return -Infinity;
        if (pickup.kind === 'chest') return (opening && !settings.resourceFarm && length > 150 ? 1200 : 2000) - distanceCost;
        if (pickup.kind === 'meat') {
            const recovery = settings.recoveryLootRush && canTankDamage(game, settings) && length <= 260 && meatHealing(pickup, game) > 0;
            return recovery ? 2200 - distanceCost : health < 0.75 ? 1000 + 100 * (1 - health) - distanceCost : -Infinity;
        }
        const priorities = { gem_blue: 170, gem_yellow: 175, gem_red: 180, exp: 170, zeny: 140 };
        if (opening && ordinaryPickup(pickup)) {
            const needsCoins = Number.isFinite(game.zeny) && typeof game.chestCost === 'function' && game.zeny < game.chestCost();
            return (pickup.kind === 'zeny' ? needsCoins ? 1740 : 1600 : 1700) - distanceCost;
        }
        if (settings.resourceFarm && pickup.kind === 'zeny' && chestBudget(game)?.shortfall > 0) return 300 - distanceCost;
        return (priorities[pickup.kind] ?? 100) - distanceCost;
    }

    class AutoExpedition {
        constructor() {
            const legacy = this.loadSettings();
            let stored;
            try { stored = JSON.parse(localStorage.getItem(MODE_SETTINGS_KEY) || 'null'); } catch {}
            const modes = normalizeModeStore(stored, legacy);
            this.modeProfiles = modes.profiles;
            this.activeMode = modes.activeMode;
            this.settings = snapshotSettings(this.modeProfiles[this.activeMode], this.activeMode);
            this.settings.panel = modes.panel;
            this.partyState = { known: false, inParty: false, members: [], role: 'unknown' };
            this.soloConfirmSince = null;
            this.partyFlow = { signature: '', phase: 'idle', attempts: 0, until: 0, at: 0 };
            this.modeCounters = { solo: { runCount: 0, retryCount: 0 }, party: { runCount: 0, retryCount: 0 } };
            this.runMode = null;
            this.enabled = false;
            this.game = null;
            this.seenGames = new WeakSet();
            this.finishedGames = new WeakSet();
            this.zones = [];
            this.arrows = [];
            this.groundWeapons = new WeakSet();
            this.groundTrackingWarnings = new Set();
            this.clearFriendlyAreas();
            this.clearRiskMotion();
            this.bellMode = null;
            this.offer = null;
            this.offerSerial = 0;
            this.cardControlSession = null;
            this.skillContext = null;
            this.skillContextSignature = '';
            this.chestContext = null;
            this.chestContextSignature = '';
            this.stageRows = [];
            this.stageSignature = '';
            this.lastAction = 0;
            this.lastMotion = 0;
            this.lastMoveIssued = 0;
            this.lastUi = 0;
            this.lastStory = 0;
            this.pickerSince = 0;
            this.pickerSignature = '';
            this.runCount = 0;
            this.retryCount = 0;
            this.retryGame = null;
            this.restartAt = 0;
            this.clearPickupGoal();
            this.blockedPickups = new WeakMap();
            this.status = '正在連接遊戲';
            this.ready = false;
            this.bindings = null;
            this.connectionState = 'idle';
            this.connectionError = '';
            this.connectPromise = null;
            this.registry = null;
            this.captureCallback = null;
            this.buildPanel();
            this.bindManualControls();
            this.timer = setInterval(() => this.safeTick(), 100);
        }

        loadSettings() {
            try {
                const saved = localStorage.getItem(SETTINGS_KEY);
                if (saved) return normalizeSettings(JSON.parse(saved));
                const gameDifficulty = JSON.parse(localStorage.getItem('ro-survivors.difficulty.v1') || '{}');
                return normalizeSettings({ difficulty: gameDifficulty });
            } catch { return normalizeSettings(); }
        }

        saveSettings() {
            this.settings = snapshotSettings(this.settings, this.activeMode);
            this.modeProfiles[this.activeMode] = snapshotSettings(this.settings, this.activeMode);
            try {
                // The old key remains a solo backup, including for a rollback.
                localStorage.setItem(SETTINGS_KEY, JSON.stringify({ ...this.modeProfiles.solo, panel: this.settings.panel }));
                localStorage.setItem(MODE_SETTINGS_KEY, JSON.stringify(this.exportSettings()));
            }
            catch { this.log('瀏覽器無法儲存設定，本次設定仍會使用'); }
        }

        settingsExportFilename(date = new Date()) {
            const component = (value, fallback) => String(value || '').trim()
                .replace(/[<>:"/\\|?*\u0000-\u001f]/g, '_').replace(/[. ]+$/g, '') || fallback;
            const parts = Object.fromEntries(new Intl.DateTimeFormat('en-US', {
                timeZone: 'Asia/Taipei', year: 'numeric', month: '2-digit', day: '2-digit',
            }).formatToParts(date).map(part => [part.type, part.value]));
            const stamp = `${parts.year}${parts.month}${parts.day}`;
            return `${component(this.skillContext?.characterName, '未知角色')}_${component(this.skillContext?.name, '未知職業')}_${stamp}.json`;
        }

        exportSettings() {
            return { format: 'ro-autoplay-modes', schema: 1, activeMode: this.activeMode,
                panel: this.settings.panel, profiles: this.modeProfiles };
        }

        importSettings(input) {
            if (input?.format === 'ro-autoplay-modes') {
                const bundle = normalizeModeStore(input, this.modeProfiles.solo);
                this.modeProfiles = bundle.profiles;
                this.settings.panel = bundle.panel;
            } else {
                this.modeProfiles[this.activeMode] = snapshotSettings(input, this.activeMode);
                if (input?.panel) this.settings.panel = normalizeSettings(input).panel;
            }
            this.applyModeSettings(this.activeMode);
        }

        applyModeSettings(mode) {
            const panel = this.settings.panel;
            if (!this.modeProfiles[mode]) this.modeProfiles[mode] = snapshotSettings(this.modeProfiles.solo, mode);
            this.activeMode = mode;
            this.settings = snapshotSettings(this.modeProfiles[mode], mode);
            this.settings.panel = panel;
            if (this.skillContext?.catalog) {
                const key = this.skillContext.key;
                this.settings.skillProfiles[key] = mergeSkillProfile(this.settings.skillProfiles[key], this.skillContext.catalog, this.settings.skillPriority);
            }
            if (this.chestContext?.groups) for (const slot of CHEST_SLOTS) {
                const key = this.chestContext.key;
                this.settings.chestProfiles[key] ||= {};
                this.settings.chestProfiles[key][slot.id] = mergeSkillProfile(this.settings.chestProfiles[key][slot.id], this.chestContext.groups[slot.id]);
            }
            this.saveSettings();
            this.skillContextSignature = '';
            this.chestContextSignature = '';
            this.refreshInputs();
        }

        isPartyRun() {
            return this.runMode === 'party' || this.activeMode === 'party' || Boolean(this.game?.coop);
        }

        syncPartyMode(now = performance.now()) {
            const root = typeof document === 'undefined' ? null : document;
            const state = readPartyState(this.game, root);
            const previous = this.partyState;
            this.partyState = state;
            const settledLobby = state.inLobby && state.online && !this.visibleSafe('#loading') && !this.visibleSafe('#gameover');
            let target = this.activeMode;
            if (state.known && state.inParty) {
                this.soloConfirmSince = null;
                if (state.inLobby || !this.game || Boolean(this.game.coop)) target = 'party';
            } else if (state.known && !state.inParty && settledLobby) {
                if (this.soloConfirmSince === null) this.soloConfirmSince = now;
                if (now - this.soloConfirmSince >= 3000) target = 'solo';
            } else this.soloConfirmSince = null;
            if (target !== this.activeMode) {
                this.modeCounters[this.activeMode] = { runCount: this.runCount, retryCount: this.retryCount };
                this.modeProfiles[this.activeMode] = snapshotSettings(this.settings, this.activeMode);
                this.cancelMovement(); this.clearRiskMotion();
                this.runCount = this.modeCounters[target].runCount;
                this.retryCount = this.modeCounters[target].retryCount;
                this.restartAt = 0; this.lastAction = now;
                this.partyFlow = { signature: '', phase: 'idle', attempts: 0, until: 0, at: now };
                this.applyModeSettings(target);
                this.log(target === 'party' ? '已載入組隊設定；單人設定已保留，單人大廳已強制停用' : '已確認離隊，恢復原本單人設定');
            }
            if (state.inLobby && state.known && state.inParty && state.signature !== this.partyFlow.signature) {
                this.partyFlow = { signature: state.signature, phase: 'idle', attempts: 0, until: now + 1500, at: now };
                if (previous?.signature && previous.signature !== state.signature && this.enabled) {
                    this.cancelMovement(); this.lastAction = now;
                    this.log('隊伍或隊長已變更，重新核對出征狀態');
                }
            }
            if (settledLobby && this.game?.state === 'over') this.runMode = null;
            this.renderModeControls();
            return state;
        }

        visibleSafe(selector) {
            try { return this.visible(selector); } catch { return false; }
        }

        renderModeControls() {
            if (!this.ui) return;
            const blocked = this.activeMode === 'party' || this.partyState?.inParty;
            const checkbox = this.ui.querySelector('[data-setting="offlineLobby"]');
            if (checkbox) { checkbox.checked = blocked ? false : this.settings.offlineLobby; checkbox.disabled = Boolean(blocked); }
            const label = this.ui.querySelector('#ra-mode');
            if (label) {
                const context = this.skillContext;
                const identity = context?.characterName ? `${context.characterName}（${context.name}）`
                    : context?.name ? `角色讀取中（${context.name}）` : '等待讀取角色';
                label.textContent = `目前設定：${this.activeMode === 'party' ? '組隊' : '單人'}${this.partyState?.role === 'leader' ? ' · 隊長' : this.partyState?.role === 'member' ? ' · 隊員' : ''} · ${identity}`;
            }
            const hint = this.ui.querySelector('#ra-party-state');
            if (hint) hint.textContent = blocked ? '隊伍中已鎖定單人大廳選項；單人設定保留，確認離隊後還原。'
                : '自動偵測隊伍並切換設定。副本中、斷線或隊伍面板暫時隱藏時保留目前模式。';
        }

        async connect() {
            if (this.connectPromise) return this.connectPromise;
            this.connectPromise = this.connectOnce();
            try { return await this.connectPromise; }
            finally { this.connectPromise = null; }
        }

        loadGameModule(url) {
            return import(url);
        }

        detachRegistry() {
            if (!this.registry || !this.captureCallback) return;
            for (const key of ['start', 'tick']) {
                const callbacks = this.registry[key];
                for (let index = callbacks.length - 1; index >= 0; index -= 1) {
                    if (callbacks[index] === this.captureCallback) callbacks.splice(index, 1);
                }
            }
            this.registry = null;
        }

        async connectOnce() {
            this.enabled = false;
            this.cancelMovement();
            this.ready = false;
            this.connectionState = 'connecting';
            this.status = '正在連接遊戲';
            this.renderStatus();
            try {
                const entry = Array.from(document.scripts).find(script => script.type === 'module' && /\/build\/main-[^/]+\.js/.test(script.src));
                if (!entry) throw new Error('目前頁面沒有遊戲主程式，請在遊戲首頁使用');
                const response = await fetch(entry.src, { credentials: 'same-origin', signal: AbortSignal.timeout(15000) });
                if (!response.ok) throw new Error(`遊戲主程式讀取失敗 (${response.status})`);
                const source = await response.text();
                const registryBinding = findRegistryBinding(source, entry.src);
                if (new URL(registryBinding.url).origin !== location.origin) throw new Error('遊戲模組來源不相符');
                const core = await this.loadGameModule(registryBinding.url);
                const registry = core[registryBinding.exported];
                if (!registry || !Array.isArray(registry.start) || !Array.isArray(registry.tick)) throw new Error('戰鬥入口結構已變更');
                const resolved = resolveGameBindings(core, source, entry.src, registryBinding.url);
                this.bindings = resolved.helpers;
                this.characterStorageKey = resolved.characterStorageKey;
                this.detachRegistry();
                this.captureCallback ??= game => this.captureGame(game);
                registry.start.push(this.captureCallback);
                registry.tick.push(this.captureCallback);
                this.registry = registry;
                this.ready = true;
                this.refreshSkillContext();
                this.refreshChestContext();
                this.connectionState = 'ready';
                this.connectionError = '';
                this.status = '已連接，按 F8 自動遠征';
                this.log(`v${VERSION} 已連接 ${entry.src.split('/').pop()}`);
                return true;
            } catch (error) {
                this.ready = false;
                this.connectionState = 'failed';
                this.connectionError = error?.message || String(error);
                this.detachRegistry();
                this.stop(`連接失敗：${this.connectionError}`);
                this.log(`連接失敗：${this.connectionError}`);
                this.log('可按「重新連接」重試。遊戲更新造成介面改變時，請安裝新版腳本。');
                return false;
            } finally {
                this.renderStatus();
            }
        }

        captureGame(game) {
            if (this.game === game) return;
            if (!point(game?.player) || !Array.isArray(game.enemies) || !Array.isArray(game.pickups) || typeof game.moveTo !== 'function') return;
            this.game = game;
            this.runMode = this.activeMode;
            this.partyFlow.phase = 'idle';
            this.partyFlow.attempts = 0;
            this.zones = [];
            this.arrows = [];
            this.clearFriendlyAreas();
            this.clearRiskMotion();
            this.bellMode = null;
            this.offer = null;
            this.cardControlSession = null;
            this.clearPickupGoal();
            this.blockedPickups = new WeakMap();
            this.restartAt = 0;
            this.retryGame = null;
            const pending = pendingNativeOffer(game);
            if (pending) this.beginOffer(pending.kind, pending.cards);
            if (this.seenGames.has(game)) return;
            this.seenGames.add(game);
            this.hookGroundSkills(game);
            if (typeof game.groundSprite === 'function') {
                const original = game.groundSprite;
                game.groundSprite = (...args) => {
                    const sprite = original.apply(game, args);
                    const cast = this.groundCast;
                    if (cast?.game === game && cast.persistent && sprite && typeof sprite === 'object') {
                        this.friendlySprites.push({ sprite, weapon: cast.weapon, createdAt: game.time });
                        if (this.friendlySprites.length > 64) this.friendlySprites.shift();
                    }
                    return sprite;
                };
            }
            if (typeof game.addWeapon === 'function') {
                const original = game.addWeapon;
                game.addWeapon = (...args) => {
                    const result = original.apply(game, args);
                    if (this.game === game) this.hookGroundSkills(game);
                    return result;
                };
            }
            const events = game.events;
            for (const [name, kind] of [['onLevelUp', 'skill'], ['onChest', 'chest'], ['onRoulette', 'roulette']]) {
                if (typeof events[name] !== 'function') continue;
                const original = events[name];
                events[name] = (...args) => {
                    const result = original.apply(events, args);
                    if (this.game === game) {
                        this.beginOffer(kind, args[0]);
                    }
                    return result;
                };
            }
            for (const [method, kind] of [['rerollDeck', 'skill'], ['rerollChest', 'chest']]) {
                if (typeof game[method] !== 'function') continue;
                const original = game[method];
                game[method] = (...args) => {
                    const cards = original.apply(game, args);
                    if (cards && this.game === game) {
                        this.offer = { kind, cards, at: performance.now(), serial: ++this.offerSerial };
                        this.log(`${kind === 'chest' ? '寶箱' : '技能'}重抽全部，剩餘 ${game.perksLeft.reroll} 次`);
                    }
                    return cards;
                };
            }
            for (const [method, kind, action] of [
                ['rerollCard', 'skill', 'reroll_card'], ['banishCard', 'skill', 'banish'], ['focusCard', 'skill', 'focus'],
                ['rerollChestCard', 'chest', 'reroll_card'], ['banishChestCard', 'chest', 'banish'], ['focusChestCard', 'chest', 'focus'],
            ]) {
                if (typeof game[method] !== 'function') continue;
                const original = game[method];
                game[method] = (...args) => {
                    const offer = this.offer, session = this.cardControlSession;
                    const before = game.perksLeft?.[action];
                    const result = original.apply(game, args);
                    if (this.game === game && offer?.kind === kind && game.perksLeft?.[action] < before) {
                        if (session) {
                            session.steps++;
                            if (action === 'focus' || session.preferenceAction) session.preferenceSteps = (session.preferenceSteps || 0) + 1;
                            if (action === 'focus') session.focusUsed = true;
                            if (kind === 'chest' && action === 'reroll_card') session.chestRerolledSlots.add(args[0].slot);
                        }
                        // Native UI replaces/splices its array AFTER this method
                        // returns. Defer the snapshot until that handler is done.
                        const deck = action === 'banish' ? args[1] : offer.cards;
                        queueMicrotask(() => {
                            if (this.game !== game || this.offer !== offer) return;
                            this.offer = deck.length ? { kind, cards: deck, at: performance.now(), serial: ++this.offerSerial } : null;
                        });
                        const label = { reroll_card: '單張重抽', banish: '放逐', focus: '專注' }[action];
                        this.log(`${kind === 'skill' ? '技能' : '寶箱'}${label} ${args[0]?.item || args[0]?.id}，剩餘 ${game.perksLeft[action]} 次`);
                    }
                    return result;
                };
            }
            if (typeof game.zoneDecal === 'function') {
                const original = game.zoneDecal;
                game.zoneDecal = (...args) => {
                    const zone = original.apply(game, args);
                    if (zone && ['circle', 'ring', 'cone', 'rect'].includes(args[0])) {
                        const hazard = { kind: args[0], parameter: args[1] || 0, zone, dead: false };
                        const dispose = zone.dispose;
                        zone.dispose = (...values) => { hazard.dead = true; return dispose.apply(zone, values); };
                        this.zones.push(hazard);
                    }
                    return zone;
                };
            }
            if (typeof game.enemyArrow === 'function') {
                const original = game.enemyArrow;
                game.enemyArrow = (enemy, x, y, speed, range) => {
                    const before = game.fx.length;
                    const angle = Math.atan2(y - enemy.y, x - enemy.x);
                    const result = original.call(game, enemy, x, y, speed, range);
                    if (game.fx.length > before) {
                        const fx = game.fx[game.fx.length - 1];
                        if (point(fx.anchor)) this.arrows.push({ fx, vx: Math.cos(angle) * speed, vy: Math.sin(angle) * speed });
                    }
                    return result;
                };
            }
            this.log(`進入 ${game.stageId}`);
        }

        beginOffer(kind, cards) {
            this.offer = { kind, cards, at: performance.now(), serial: ++this.offerSerial };
            this.cardControlSession = { kind, steps: 0, preferenceSteps: 0, focusUsed: false, failed: new Set(), chestRerolledSlots: new Set() };
        }

        syncNativeOffer() {
            const pending = pendingNativeOffer(this.game);
            if (pending && (this.offer?.kind !== pending.kind || this.offer.cards !== pending.cards)) {
                this.beginOffer(pending.kind, pending.cards);
            }
        }

        clearFriendlyAreas() {
            this.friendlySprites = [];
            this.groundBursts = [];
            this.recoveryFields = [];
            this.groundCast = null;
        }

        hookGroundSkills(game) {
            for (const weapon of game.weapons || []) {
                if (!weapon || typeof weapon !== 'object' || this.groundWeapons.has(weapon)) continue;
                const tags = weapon.tags || this.bindings?.skills?.[weapon.id]?.tags || [];
                if (!tags.includes('ground') && weapon.id !== 'sanctuary') continue;
                this.groundWeapons.add(weapon);
                const persistent = tags.includes('persistent') || weapon.type === 'zone';
                for (const method of ['fire', 'onFire']) {
                    const original = weapon[method];
                    if (typeof original !== 'function') continue;
                    weapon[method] = (...args) => {
                        const actor = args[0];
                        if (actor !== this.game) return original.apply(weapon, args);
                        const previous = this.groundCast;
                        this.groundCast = { game: actor, weapon, persistent };
                        let result;
                        try { result = original.apply(weapon, args); }
                        finally { this.groundCast = previous; }
                        if (result === true && method === 'onFire' && weapon.id === 'sanctuary' && typeof weapon.mod === 'function') {
                            const mod = weapon.mod(actor);
                            const radius = 130 * actor.stats.areaMult * (1 + (mod.area || 0));
                            const duration = 8 * (1 + (mod.duration || 0));
                            if (Number.isFinite(radius) && radius > 0 && Number.isFinite(duration) && duration > 0) {
                                this.recoveryFields = this.recoveryFields.filter(field => field.until > actor.time);
                                this.recoveryFields.push({ x: actor.player.x, y: actor.player.y, radius, weapon, until: actor.time + duration });
                                if (this.recoveryFields.length > 32) this.recoveryFields.shift();
                            }
                        }
                        if (result === true && method === 'fire') {
                            try { this.recordGroundBurst(actor, weapon); }
                            catch (error) {
                                if (!this.groundTrackingWarnings.has(weapon.id)) {
                                    this.groundTrackingWarnings.add(weapon.id);
                                    this.log(`無法識別 ${weapon.id} 的地面範圍：${error.message}`);
                                }
                            }
                        }
                        return result;
                    };
                }
            }
        }

        recordGroundBurst(game, weapon) {
            const cfg = weapon.cfg;
            if (!point(weapon.shot) || typeof weapon.radii !== 'function' || typeof cfg?.ticks !== 'function'
                || !Number.isFinite(cfg.interval) || cfg.interval <= 0) return;
            const radii = weapon.radii(game);
            const mod = typeof weapon.mod === 'function' ? weapon.mod(game) : {};
            const ticks = Math.round(cfg.ticks(weapon.level)) + (mod.count || 0);
            const duration = Math.max(0, ticks - 1) * cfg.interval;
            const radius = cfg.scatter === false ? radii.tr : radii.area + radii.tr;
            if (!Number.isFinite(duration) || duration < 0.6 || !Number.isFinite(radius) || radius <= 0) return;
            const startsAt = game.time + Math.max(0, cfg.delay || 0);
            this.groundBursts.push({ weapon, x: weapon.shot.x, y: weapon.shot.y, radius, startsAt, until: startsAt + duration });
            if (this.groundBursts.length > 64) this.groundBursts.shift();
        }

        activeFriendlyAreas() {
            const game = this.game;
            if (!game) return [];
            const weapons = new Set(game.weapons || []);
            const name = weapon => this.bindings?.skills?.[weapon.id]?.name || weapon.id || '友方地面技能';
            const areas = [];
            this.friendlySprites = this.friendlySprites.filter(field => !field.sprite.disposed && weapons.has(field.weapon)
                && game.time - field.createdAt < 120);
            for (const field of this.friendlySprites) {
                const sprite = field.sprite;
                if (game.time - field.createdAt < 0.05 || !point(sprite) || !(sprite.size > 0) || !((sprite.alpha ?? 1) > 0)) continue;
                areas.push({ x: sprite.x, y: sprite.y, radius: sprite.size / 2, name: name(field.weapon) });
            }
            for (const weapon of weapons) {
                const tags = weapon.tags || this.bindings?.skills?.[weapon.id]?.tags || [];
                if (!tags.includes('ground') || !Array.isArray(weapon.zones) || !(weapon.cfg?.cellRadius > 0)) continue;
                const mod = typeof weapon.mod === 'function' ? weapon.mod(game) : {};
                const radius = weapon.cfg.cellRadius * game.stats.areaMult * (1 + (mod.area || 0));
                if (!Number.isFinite(radius) || radius <= 0) continue;
                for (const zone of weapon.zones) if (point(zone) && zone.until > game.time) {
                    areas.push({ x: zone.x, y: zone.y, radius, name: name(weapon) });
                }
            }
            this.groundBursts = this.groundBursts.filter(field => weapons.has(field.weapon) && field.until > game.time);
            for (const field of this.groundBursts) if (field.startsAt <= game.time) areas.push({ ...field, name: name(field.weapon) });
            this.recoveryFields = this.recoveryFields.filter(field => weapons.has(field.weapon) && field.until > game.time);
            for (const field of this.recoveryFields) areas.push({ ...field, name: name(field.weapon) });
            return areas;
        }

        readTownCharacter() {
            const helpers = this.bindings;
            const label = document.querySelector('#lobby-labels .self');
            const name = label?.firstChild?.textContent?.trim();
            if (!name || !this.characterStorageKey || typeof helpers.scopeKey !== 'function' || !helpers.storage?.getItem) return null;
            try {
                const records = JSON.parse(helpers.storage.getItem(helpers.scopeKey(this.characterStorageKey)) || '[]');
                const character = Array.isArray(records) ? records.find(record => record.name === name) : null;
                if (!character?.job) return null;
                // Native equipment is stored on the character. Only legacy
                // saves without an inventory field use the account fallback.
                const inventory = Array.isArray(character.inventory) ? character.inventory
                    : JSON.parse(helpers.storage.getItem(helpers.scopeKey('ro-survivors.account.v1')) || '{}').inventory ?? [];
                const gear = slot => Array.isArray(inventory) ? inventory.find(item => item.uid === character.equipped?.[slot]) : null;
                const weapon = gear('weapon');
                const weaponType = helpers.equipmentDefinitions?.[weapon?.itemId]?.wtype;
                const shield = helpers.equipmentDefinitions?.[gear('shield')?.itemId]?.slot === 'shield';
                const job = character.job === 'novice' ? 'swordsman' : character.job;
                const talents = character.talents ?? {};
                const talentContext = readTalentSkills({ job, talents, shield, weaponType }, helpers);
                return {
                    job,
                    name: character.name,
                    promotion: character.promotion,
                    gender: character.look?.gender,
                    learned: talentContext.learned, starts: talentContext.starts, shield, weaponType,
                    talents, talentContext,
                    weaponItem: weapon?.itemId,
                };
            } catch { return null; }
        }

        refreshSkillContext() {
            if (!this.ready || !this.bindings?.skillPool || !this.bindings.assets?.manifest) return;
            let character;
            const inTown = this.visible('#lobby-ui');
            if (inTown) character = this.readTownCharacter();
            else if (this.game?.classDef) character = {
                job: this.game.classDef.id,
                name: document.querySelector('#hud-name span')?.textContent?.trim(),
                promotion: this.game.promotion ?? this.game.look?.promotion,
                gender: this.game.look?.look?.gender,
                learned: this.game.loadout?.learned ?? [],
                starts: this.game.loadout?.starts ?? [],
                weaponItem: this.game.loadout?.weapon?.itemId,
                weaponType: this.game.loadout?.weapon?.wtype,
                shield: Boolean(this.game.loadout?.shield),
                basicId: this.game.basicAttack,
            };
            if (!character) return;
            const helpers = this.bindings;
            const jobId = character.promotion || character.job;
            const job = helpers.classById(jobId);
            const className = helpers.displayClass ? helpers.displayClass(job, character.gender) : job.name;
            const game = inTown ? null : this.game, source = inTown ? 'town' : 'run';
            const pending = pendingNativeOffer(game);
            const offered = pending?.kind === 'skill' ? pending.cards
                : !inTown && this.visible('#picker') && this.offer?.kind === 'skill' ? this.offer.cards : [];
            const catalog = buildSkillCatalog(character, helpers, game, offered);
            const selectedTalents = character.talentContext?.selected;
            const signature = JSON.stringify([jobId, className, source, character.name, character.basicId, selectedTalents, catalog]);
            if (signature === this.skillContextSignature) return;
            this.skillContextSignature = signature;
            this.skillContext = { key: jobId, name: className, catalog, source, basicId: character.basicId,
                characterName: character.name, selectedTalents };
            this.settings.skillProfiles[jobId] = mergeSkillProfile(this.settings.skillProfiles[jobId], catalog, this.settings.skillPriority);
            this.saveSettings();
            this.renderSkillList();
        }

        renderSkillList() {
            if (!this.ui) return;
            const context = this.skillContext;
            const label = this.ui.querySelector('#ra-job');
            const list = this.ui.querySelector('#ra-skill-list');
            if (!context) { label.textContent = '等待讀取目前角色職業'; return; }
            label.textContent = `${context.characterName ? `${context.characterName} · ` : '目前職業　'}${context.name} · ${context.catalog.length - 1} 項技能＋普通攻擊`;
            const status = this.ui.querySelector('#ra-talents');
            if (status) {
                const selected = context.selectedTalents;
                status.textContent = selected ? `已讀取 ${selected.length} 項天賦（${selected.reduce((sum, talent) => sum + talent.rank, 0)} 點）；依官方可抽技能列出。`
                    : '依本局原生技能池與實際手牌同步。';
                status.title = selected ? [...selected.map(talent => `${talent.name} ${talent.rank}${talent.active ? '' : '（裝備條件未符合）'}`),
                    '常駐天賦效果不會自動變成可抽卡片；實際出現的手牌會立即補入。'].join('\n') : '';
            }
            this.renderPriorityList(list, context.catalog, () => this.settings.skillProfiles[context.key], () => this.renderSkillList());
            this.renderModeControls();
        }

        keepPanelScroll(update, extra = []) {
            const scrollers = new Set(extra);
            if (this.ui) {
                scrollers.add(this.ui.querySelector('#ra-body'));
                for (const list of this.ui.querySelectorAll('.skill-list')) scrollers.add(list);
            }
            const positions = [...scrollers].filter(Boolean).map(element => [element, element.scrollTop, element.scrollLeft]);
            const focused = this.ui?.activeElement;
            update();
            // Keep the original focused control, even in browsers without atomic DOM moves.
            if (focused?.isConnected && !focused.disabled && this.ui.activeElement !== focused) focused.focus({ preventScroll: true });
            for (const [element, top, left] of positions) {
                element.scrollTop = top;
                element.scrollLeft = left;
            }
        }

        placeRow(container, row, index) {
            if (container.children[index] === row) return;
            const before = container.children[index] || null;
            if (row.parentNode === container && container.moveBefore) container.moveBefore(row, before);
            else container.insertBefore(row, before);
        }

        renderPriorityList(list, catalog, getProfile, onChange) {
            this.keepPanelScroll(() => {
                const profile = getProfile();
                const blocked = new Set(profile.excluded);
                const definitions = new Map(catalog.map(entry => [entry.id, entry]));
                const rows = new Map(Array.from(list.children).map(row => [row.dataset.priorityId, row]));
                const known = profile.order.filter(id => definitions.has(id));
                const enabled = known.filter(id => !blocked.has(id));
                const excluded = known.filter(id => blocked.has(id));
                const visible = [...enabled, ...excluded];
                for (const [index, id] of visible.entries()) {
                    const skill = definitions.get(id);
                    let row = rows.get(id);
                    if (!row) {
                        row = document.createElement('div');
                        row.dataset.priorityId = id;
                        const image = document.createElement('img');
                        image.alt = '';
                        image.loading = 'eager';
                        image.decoding = 'async';
                        image.onerror = () => { image.style.visibility = 'hidden'; };
                        const name = document.createElement('span');
                        name.className = 'skill-name';
                        const title = document.createElement('span');
                        const detail = document.createElement('small');
                        name.append(title, detail);
                        const up = document.createElement('button');
                        const down = document.createElement('button');
                        const exclude = document.createElement('button');
                        up.textContent = '↑'; down.textContent = '↓'; exclude.textContent = '❌';
                        row.append(image, name, up, down, exclude);
                        row.priorityControls = { image, name, title, detail, up, down, exclude };
                    }
                    rows.delete(id);
                    row.className = `skill-row${blocked.has(id) ? ' excluded' : ''}`;
                    const { image, name, title, detail, up, down, exclude } = row.priorityControls;
                    if (image.getAttribute('src') !== skill.icon) { image.style.visibility = ''; image.src = skill.icon; }
                    title.textContent = skill.name;
                    name.title = [skill.name, skill.description, id].filter(Boolean).join('\n');
                    detail.textContent = skill.detail || '';
                    detail.hidden = !skill.detail;
                    for (const [direction, button] of [[-1, up], [1, down]]) {
                        const group = blocked.has(id) ? excluded : enabled;
                        const groupIndex = group.indexOf(id);
                        button.title = `${direction < 0 ? '提高' : '降低'} ${skill.name} 的優先度`;
                        button.setAttribute('aria-label', button.title);
                        button.disabled = groupIndex + direction < 0 || groupIndex + direction >= group.length;
                        button.onclick = () => {
                            if (moveSkill(getProfile(), id, direction)) { this.saveSettings(); onChange(); }
                        };
                    }
                    exclude.title = blocked.has(id) ? `恢復 ${skill.name}` : `排除 ${skill.name}`;
                    exclude.setAttribute('aria-label', exclude.title);
                    exclude.setAttribute('aria-pressed', String(blocked.has(id)));
                    exclude.onclick = () => {
                        const current = getProfile();
                        current.excluded = current.excluded.includes(id) ? current.excluded.filter(value => value !== id) : [...current.excluded, id];
                        this.saveSettings(); onChange();
                    };
                    this.placeRow(list, row, index);
                }
                for (const row of rows.values()) row.remove();
            }, [list]);
        }

        refreshChestContext() {
            const helpers = this.bindings;
            const context = this.skillContext;
            if (!this.ready || !context || !helpers?.itemDefinitions || !helpers.canDeify) return;
            const game = context.source === 'run' ? this.game : null;
            const pending = pendingNativeOffer(game);
            const offered = pending?.kind === 'chest' ? pending.cards
                : game && this.visible('#picker') && this.offer?.kind === 'chest' ? this.offer.cards : [];
            const groups = buildChestCatalog(helpers.itemDefinitions, context.catalog, helpers.canDeify, item =>
                item.img ? new URL(`assets/${item.img}`, location.origin).href : helpers.itemIcon(item.icon), game, offered);
            const signature = JSON.stringify([context.key, context.name, groups]);
            if (signature !== this.chestContextSignature) {
                this.chestContextSignature = signature;
                this.chestContext = { key: context.key, name: context.name, groups };
                const saved = this.settings.chestProfiles[context.key] ?? {};
                this.settings.chestProfiles[context.key] = Object.fromEntries(CHEST_SLOTS.map(slot =>
                    [slot.id, mergeSkillProfile(saved[slot.id], groups[slot.id])]));
                this.saveSettings();
                this.renderChestGroups();
            }
            this.updateChestOwned();
        }

        renderChestGroups() {
            if (!this.ui) return;
            const context = this.chestContext;
            const label = this.ui.querySelector('#ra-chest-job');
            if (!context) { label.textContent = '等待讀取目前角色職業'; return; }
            label.textContent = `目前職業　${context.name}`;
            const container = this.ui.querySelector('#ra-chest-groups');
            this.keepPanelScroll(() => {
                const groups = new Map(Array.from(container.children).map(group => [group.dataset.slot, group]));
                for (const [index, slot] of CHEST_SLOTS.entries()) {
                    let group = groups.get(slot.id);
                    if (!group) {
                        group = document.createElement('details');
                        group.dataset.slot = slot.id;
                        const summary = document.createElement('summary');
                        summary.textContent = slot.name;
                        const owned = document.createElement('div');
                        owned.className = 'hint';
                        owned.dataset.ownedSlot = slot.id;
                        const list = document.createElement('div');
                        list.className = 'skill-list';
                        list.dataset.listSlot = slot.id;
                        group.append(summary, owned, list);
                    }
                    this.placeRow(container, group, index);
                    const list = group.querySelector('.skill-list');
                    this.renderPriorityList(list, context.groups[slot.id], () => this.settings.chestProfiles[context.key][slot.id], () => this.renderChestGroups());
                }
            });
            this.updateChestOwned();
        }

        updateChestOwned() {
            if (!this.ui || !this.chestContext) return;
            const game = this.visible('#lobby-ui') ? null : this.game;
            for (const slot of CHEST_SLOTS) {
                const label = this.ui.querySelector(`[data-owned-slot="${slot.id}"]`);
                if (!label) continue;
                const owned = game?.runItems?.slots.get(slot.id);
                const item = this.chestContext.groups[slot.id].find(entry => entry.id === owned?.item);
                label.textContent = owned ? `本局　${item?.name || owned.item} +${Math.max(0, owned.vals.length - 1)}` : '本局尚未取得';
            }
        }

        start() {
            if (!this.ready) {
                this.log(this.connectionError ? `上次連接失敗：${this.connectionError}，正在重試` : '正在連接，完成後請再按 F8');
                this.connect();
                return;
            }
            this.syncPartyMode();
            this.runCount = 0;
            this.retryCount = 0;
            this.clearRiskMotion();
            this.enabled = true;
            this.restartAt = 0;
            this.status = '已啟動';
            this.lastAction = 0;
            this.partyFlow.phase = 'idle'; this.partyFlow.attempts = 0; this.partyFlow.until = 0;
            this.renderStatus();
        }

        stop(reason = '已停止') {
            this.enabled = false;
            this.cancelMovement();
            this.clearRiskMotion();
            this.status = reason;
            this.renderStatus();
        }

        cancelMovement() {
            if (this.game?.movePath) this.game.movePath = null;
            if (this.game?.mouse) this.game.mouse.holding = false;
        }

        safeTick() {
            try { this.tick(); }
            catch (error) { this.stop(`操作已停止，${error.message}`); this.log(error.message); }
        }

        visible(selector) {
            const element = typeof selector === 'string' ? document.querySelector(selector) : selector;
            return Boolean(element && element.isConnected && !element.classList.contains('hidden') && element.getClientRects().length && getComputedStyle(element).visibility !== 'hidden');
        }

        click(element, interval = 850) {
            if (!this.visible(element) || element.disabled || performance.now() - this.lastAction < interval) return false;
            element.click();
            this.lastAction = performance.now();
            return true;
        }

        tick() {
            const now = performance.now();
            this.syncPartyMode(now);
            if (this.handleChineseChannelPrompt()) { this.renderStatus(); return; }
            if (this.handleOfflineLobby()) { this.renderStatus(); return; }
            if (now - this.lastUi > 500) {
                this.lastUi = now;
                this.readStageRows();
                this.refreshSkillContext();
                this.refreshChestContext();
                this.renderStatus();
            }
            if (!this.enabled || !this.ready) return;
            if (document.hidden) { this.cancelMovement(); this.status = '分頁隱藏，等待返回'; return; }
            if (this.visible('#loading') || this.visible('#pause')) { this.cancelMovement(); this.status = '等待遊戲載入或手動繼續'; return; }
            if (this.handleServerConnectionNotice()) return;
            if (this.visible('#gameover')) { this.handleGameOver(now); return; }
            if (this.visible('#drop-reveal')) { this.cancelMovement(); this.handleDrop(); return; }
            if (this.visible('#picker')) { this.cancelMovement(); this.handlePicker(now); return; }
            if (this.handlePartyLobby(now)) { this.cancelMovement(); return; }
            if (this.visible('#festival')) { this.cancelMovement(); this.handleFestival(); return; }
            if (this.visible('#stages')) { this.cancelMovement(); this.handleStages(); return; }
            if (this.visible('#npc-dialog')) { this.cancelMovement(); this.handleDifficulty(); return; }
            if (this.visible('#lobby-ui')) { this.handleTown(now); return; }
            const game = this.game;
            if (!game) { this.status = '等待戰鬥狀態'; return; }
            if (game.state === 'cutscene') {
                this.cancelMovement();
                this.status = '劇情對話';
                if (game.story?.sayDone && now - this.lastStory > 700) {
                    this.lastStory = now;
                    document.getElementById('story')?.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, pointerType: 'mouse' }));
                }
                return;
            }
            if (game.state !== 'playing' || game.player.dead) { this.status = `等待遊戲 (${game.state})`; return; }
            if (now - this.lastMotion < this.settings.decisionMs) return;
            this.lastMotion = now;
            this.handleCombat(now);
        }

        handleOfflineLobby() {
            const state = readPartyState(this.game, typeof document === 'undefined' ? null : document);
            if (this.activeMode === 'party' || state.inParty || !this.enabled || !this.ready || !this.settings.offlineLobby || document.hidden || !this.visible('#npc-dialog')) return false;
            // This is the game's lobby picker, not a generic NPC/confirmation dialog.
            if (!document.querySelector('#npc-text .lb-pick')) return false;
            const labels = new Set(['單人大廳', '单人大廳', '单人大厅', 'solo lobby', 'lobby solo', '離線遊玩', '离线游玩', 'jugar sin conexión', 'play offline', 'jogar offline', 'jogar sem conexão']);
            const button = Array.from(document.querySelectorAll('#npc-options button')).find(element => labels.has(normalized(element.textContent)));
            if (!button || !this.visible(button)) return false;
            this.cancelMovement();
            if (this.click(button, 850)) {
                const label = button.textContent.trim();
                this.log(`已在選擇大廳視窗點選「${label}」；新版遠征仍需伺服器連線`);
                this.status = `已選擇${label}，繼續自動遠征`;
            }
            return true;
        }

        handlePartyLobby(now) {
            if (this.activeMode !== 'party') return false;
            const state = this.partyState;
            if (!state.inLobby) {
                if (!this.game || this.game.state === 'over') { this.status = '組隊：等待大廳與隊伍狀態'; return true; }
                return false;
            }
            if (!state.known || !state.inParty || !state.online) {
                this.status = '組隊：等待連線或確認是否離隊'; return true;
            }
            if (!['leader', 'member'].includes(state.role)) { this.status = '組隊：等待確認隊長身份'; return true; }
            const flow = this.partyFlow;
            const dialog = this.visible('#npc-dialog');
            const title = document.querySelector('#npc-name')?.textContent || '';
            const text = document.querySelector('#npc-text')?.textContent || '';
            const kind = dialog ? partyDialogKind(title, text) : null;
            if (kind === 'blocked') {
                this.stop('隊伍不符合副本條件；請確認角色資格與關卡類型後再按 F8');
                return true;
            }
            if (state.pending && ['waiting', 'accepted'].includes(flow.phase) && now - flow.at > 90000) {
                this.stop('組隊準備超過 90 秒仍未完成，請確認原生隊伍狀態後再按 F8');
                return true;
            }
            if (state.role === 'member') {
                if (this.visible('#festival')) {
                    this.status = '隊員：關閉活動面板，等待隊長提議';
                    this.click(document.getElementById('festival-close'));
                    return true;
                }
                if (this.visible('#stages')) {
                    this.status = '隊員：關閉選圖介面，等待隊長提議';
                    this.click(document.getElementById('stg-close'));
                    return true;
                }
                if (kind === 'ready' && state.pending && !state.members.find(member => member.self)?.ready) {
                    if (!this.settings.partyAutoReady) { this.status = '隊員：等待手動確認準備'; return true; }
                    const proposedBy = document.querySelector('#npc-text b')?.textContent || '';
                    const leaderName = state.leaderName?.replace(/[&<>"]/g, '');
                    if (!leaderName || normalized(proposedBy) !== normalized(leaderName)) {
                        this.status = '隊員：提議與目前隊長不符，等待重新確認'; return true;
                    }
                    if (flow.phase === 'accepted') { this.status = '隊員：已送出準備，等待全員入場'; return true; }
                    const readyLabels = new Set(['準備好了！', '准备好了！', 'ready!', '¡listo!', 'pronto!'].map(normalized));
                    const button = Array.from(document.querySelectorAll('#npc-options button')).find(item => readyLabels.has(normalized(item.textContent)));
                    if (!button || button.disabled || !this.visible(button)) { this.status = '隊員：等待可用的準備按鈕'; return true; }
                    this.status = '隊員：確認組隊出征準備';
                    if (this.click(button)) { flow.phase = 'accepted'; flow.at = now; this.log('已依目前隊長的原生出征提議確認準備'); }
                    return true;
                }
                if (!state.pending) flow.phase = 'idle';
                this.status = state.pending ? '隊員：等待全員準備與正式入場' : '隊員：等待隊長提議下一場';
                return true;
            }
            const ready = state.members.filter(member => member.ready).length;
            if (state.pending) {
                // Also count a native proposal started outside our difficulty button.
                if (!['proposing', 'waiting'].includes(flow.phase)) { flow.attempts++; flow.at = now; }
                flow.phase = 'waiting';
                this.status = `隊長：等待 ${ready}/${state.members.length} 人準備，或等待正式入場`;
                return true;
            }
            if (flow.phase === 'waiting') {
                flow.phase = 'cooldown'; flow.until = now + this.settings.partyRetryDelay * 1000;
                this.log('原生準備流程已結束，等待後重新核對隊伍');
            }
            if (flow.phase === 'proposing') {
                if (now - flow.at > 15000) this.stop('出征提議未收到原生確認，請確認連線與隊伍後再按 F8');
                else this.status = '隊長：等待伺服器確認出征提議';
                return true;
            }
            if (now < flow.until) { this.status = `隊長：${Math.ceil((flow.until - now) / 1000)} 秒後重新確認出征`; return true; }
            if (flow.attempts >= this.settings.partyRetryLimit) { this.stop('組隊出征已達重試上限，請確認隊員狀態後再按 F8'); return true; }
            const away = state.members.filter(member => !member.online || !member.sameChannel);
            if (away.length) { this.status = `隊長：等待 ${away.length} 名隊員回到同一頻道大廳`; return true; }
            if (dialog && kind !== 'ready' && !departureDialogKind(document)) {
                this.status = '隊長：目前對話需手動處理，完成後接續組隊'; return true;
            }
            return false;
        }

        handleChineseChannelPrompt() {
            if (!this.settings.declineChineseChannel || document.hidden || !this.visible('#npc-dialog')) return false;
            const title = document.querySelector('#npc-name')?.textContent || '';
            const text = document.querySelector('#npc-text')?.textContent || '';
            const content = `${title} ${text}`;
            if (!/中文|chinese|chino|chin[eê]s/i.test(content) || !/頻道|频道|channel|canal/i.test(content)) return false;
            const labels = new Set(['現在不要', '现在不要', 'not now', 'ahora no', 'agora não']);
            const button = Array.from(document.querySelectorAll('#npc-options button')).find(element => labels.has(normalized(element.textContent)));
            if (!button || button.disabled || !this.visible(button)) return false;
            this.cancelMovement();
            if (this.click(button, 850)) this.log('中文頻道詢問已選擇「現在不要」');
            return true;
        }

        handleServerConnectionNotice() {
            if (!this.visible('#npc-dialog')) return false;
            const text = normalized(document.querySelector('#npc-text')?.textContent || '');
            const messages = ['沒有連線到伺服器就無法開始關卡', '没有连接到服务器就无法开始关卡',
                'you cannot start a run without a connection to the server',
                'sin conexión con el servidor no se puede empezar', 'sem conexão com o servidor não dá para começar'];
            if (!messages.some(message => text.includes(message))) return false;
            this.stop('遠征需要伺服器連線，請恢復連線後按 F8');
            return true;
        }

        readStageRows() {
            if (!this.visible('#stages')) return;
            const rows = Array.from(document.querySelectorAll('#stg-list .stg-card')).map(element => ({
                element, index: Number(element.dataset.i), name: element.querySelector('b')?.textContent.trim() || '',
                unlocked: !element.disabled && (element.classList.contains('open') || element.classList.contains('cleared')),
                state: element.querySelector('.stg-state')?.textContent.trim() || '',
            }));
            const signature = rows.map(row => `${row.name}/${row.state}`).join('|');
            this.stageRows = rows;
            if (signature === this.stageSignature) return;
            this.stageSignature = signature;
            const select = this.ui.querySelector('#ra-stage');
            select.replaceChildren();
            for (const [value, label] of [['first', '第一個可挑戰副本'], ['last', '最後一個可挑戰副本'],
                [LANTERN_STAGE.id, LANTERN_STAGE.name]]) select.add(new Option(label, value));
            for (const row of rows) {
                const option = new Option(`${row.name} · ${row.state}`, row.name);
                option.disabled = !row.unlocked;
                select.add(option);
            }
            select.value = this.settings.stage;
            if (select.selectedIndex < 0) select.value = 'first';
        }

        handleStages() {
            if (!this.partyLeaderCanAct()) return;
            if (isLanternStage(this.settings.stage)) {
                this.status = '燈籠節需由節慶主持人進場，關閉一般選關';
                this.click(document.getElementById('stg-close'));
                return;
            }
            this.readStageRows();
            const stage = pickStage(this.stageRows, this.settings.stage);
            if (!stage) { this.stop('目前沒有可挑戰的副本'); return; }
            this.status = `選擇 ${stage.name}`;
            if (!stage.element.classList.contains('sel')) { this.click(stage.element); return; }
            const go = document.getElementById('stg-go');
            if (this.click(go)) this.log(`出征 ${stage.name}`);
        }

        handleFestival() {
            if (!this.partyLeaderCanAct()) return;
            if (!isLanternStage(this.settings.stage)) {
                this.status = '關閉活動面板，繼續一般遠征';
                this.click(document.getElementById('festival-close'));
                return;
            }
            this.status = '燈籠節：開啟固定難度出征設定';
            if (this.click(document.getElementById('festival-play'))) this.log('燈籠節：已由節慶主持人選擇出征');
        }

        handleDifficulty() {
            if (!this.partyLeaderCanAct()) return;
            const kind = departureDialogKind(document);
            if (!kind) { this.status = '目前對話需手動處理，完成後自動接續'; return; }
            const festival = isLanternStage(this.settings.stage);
            if ((kind === 'fixed') !== festival) {
                this.status = '出征視窗與所選副本不同，關閉後重新前往入口';
                const cancel = Array.from(document.querySelectorAll('#npc-options button')).find(button => !button.classList.contains('primary'));
                this.click(cancel);
                return;
            }
            const inputs = Array.from(document.querySelectorAll('#npc-text .diff input[data-key]'));
            this.status = festival ? '燈籠節：固定難度，確認即時升級' : '套用出征難度';
            if (performance.now() - this.lastAction < 850) return;
            if (festival) {
                // The existing picker handles one upgrade at a time. Avoid
                // inheriting the game's accumulated-upgrades mode from another run.
                const immediate = document.querySelector('#npc-text .diff .diff-bank [data-bank="0"]');
                if (!immediate.classList.contains('active')) { this.click(immediate); return; }
            } else {
                for (const input of inputs) {
                    const value = this.settings.difficulty[input.dataset.key];
                    if (!Number.isFinite(value)) continue;
                    input.value = String(clamp(value, Number(input.min), Number(input.max)));
                    input.dispatchEvent(new Event('input', { bubbles: true }));
                }
            }
            if (this.click(document.querySelector('#npc-options button.primary')) && this.activeMode === 'party') {
                this.partyFlow.phase = 'proposing'; this.partyFlow.at = performance.now(); this.partyFlow.attempts++;
                this.status = '隊長：已提議出征，等待全員準備';
            }
        }

        partyLeaderCanAct() {
            if (this.activeMode !== 'party') return true;
            const state = readPartyState(this.game, typeof document === 'undefined' ? null : document);
            const valid = state.inParty && state.inLobby && state.online && state.role === 'leader' && !state.pending
                && state.signature === this.partyFlow.signature && state.members.every(member => member.online && member.sameChannel)
                && !['proposing', 'waiting'].includes(this.partyFlow.phase)
                && this.partyFlow.attempts < this.settings.partyRetryLimit && performance.now() >= this.partyFlow.until;
            if (!valid) this.status = '組隊：等待隊長、隊員位置與準備狀態確認';
            return Boolean(valid);
        }

        handleTown(now) {
            if (!this.partyLeaderCanAct()) return;
            const festival = isLanternStage(this.settings.stage);
            const target = festival ? '節慶主持人' : '遠征隊長';
            this.status = `前往${target}`;
            const prompt = document.getElementById('lobby-prompt');
            if (this.visible(prompt) && townNpcMatches(prompt.textContent, festival, true)) { this.click(prompt); return; }
            if (now - this.lastAction < 1600) return;
            const label = Array.from(document.querySelectorAll('#lobby-labels .npc')).find(element => townNpcMatches(element.textContent, festival));
            const canvas = document.querySelector('#stage canvas:last-child');
            if (!label || !canvas) { this.status = festival ? '等待節慶主持人標籤，請確認活動仍開放' : '等待遠征隊長標籤'; return; }
            const rect = label.getBoundingClientRect();
            const area = canvas.getBoundingClientRect();
            const x = clamp(rect.left + rect.width / 2, area.left + 25, area.right - 25);
            const y = clamp(rect.bottom + this.settings.npcOffset, area.top + 25, area.bottom - 75);
            // The current plaza's tap-to-walk handler commits a path on touch
            // pointerup. A mouse down/up in the same frame never starts walking.
            canvas.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, pointerType: 'touch', pointerId: 1, isPrimary: true, button: 0, buttons: 1, clientX: x, clientY: y }));
            window.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, pointerType: 'touch', pointerId: 1, isPrimary: true, button: 0, buttons: 0, clientX: x, clientY: y }));
            this.lastAction = now;
        }

        handleDrop() {
            this.status = '取得掉落';
            const take = document.querySelector('#drop-reveal .dr-get') ?? document.querySelector('#drop-reveal [data-c="need"]');
            this.click(take, 800);
        }

        handlePicker(now) {
            const picker = document.getElementById('picker');
            if (picker.classList.contains('closing')) { this.offer = null; this.cardControlSession = null; return; }
            this.syncNativeOffer();
            const cards = Array.from(document.querySelectorAll('#pk-cards .pk-card'));
            if (!cards.length) return;
            const signature = `${this.offer?.serial || 0}|${cards.map(card => card.textContent).join('|')}`;
            if (signature !== this.pickerSignature) { this.pickerSignature = signature; this.pickerSince = now; }
            if (now - this.pickerSince < this.settings.choiceDelay * 1000) return;
            const kind = this.offer?.kind;
            if (!this.offer || this.offer.cards?.length !== cards.length) {
                this.status = '此選擇需手動處理，選完後自動接續';
                return;
            }
            let index = 0;
            let qualityFallback = false;
            let exhaustedFallback = false;
            if (kind === 'skill') {
                this.refreshSkillContext();
                const profile = this.skillContext && this.settings.skillProfiles[this.skillContext.key];
                if (!profile && !(this.settings.fallbackLockedReroll && rerollIsLocked(this.game))) { this.status = '等待讀取職業技能'; return; }
                let decision = profile ? configuredSkillDecision(this.offer.cards, profile, this.settings,
                    this.game.time, this.game.perksLeft?.reroll || 0, this.game.basicAttack) : { action: 'wait' };
                if (this.isPartyRun() && decision.action === 'restart') decision = { action: 'wait' };
                if (this.tryCardControls('skill', profile, decision)) return;
                decision = this.withLockedRerollFallback(decision, 'skill');
                decision = this.withExhaustedChoiceFallback(decision, 'skill', profile);
                if (decision.action === 'reroll') {
                    this.rerollCurrentOffer('技能');
                    return;
                }
                if (decision.action === 'restart') { this.restartForSkillBuild(); return; }
                if (decision.action === 'wait') {
                    this.status = '沒有合適技能，等待調整技能設定或手動選擇';
                    this.logChoiceWait('skill', profile);
                    return;
                }
                index = decision.index;
                qualityFallback = Boolean(decision.fallback);
                exhaustedFallback = Boolean(decision.exhausted);
                this.status = exhaustedFallback ? '重抽／放逐不可用，備援選技能'
                    : qualityFallback ? '尚未解鎖重抽，依最高品質選技能'
                    : this.settings.learnFirst && this.offer.cards[index].isNew ? '先取得新技能' : '依配置升級技能';
            } else if (kind === 'chest') {
                this.refreshSkillContext();
                this.refreshChestContext();
                const profiles = this.chestContext && this.settings.chestProfiles[this.chestContext.key];
                if (!profiles && !(this.settings.fallbackLockedReroll && rerollIsLocked(this.game))) { this.status = '等待讀取寶箱與神祇配置'; return; }
                const owned = this.game.runItems.slots;
                const eligible = new Set(profiles ? chestCandidateRanks(this.offer.cards, profiles, owned).map(entry => entry.index) : []);
                const scores = this.offer.cards.map((card, position) => eligible.has(position) ? this.chestScore(card, cards[position]) : -Infinity);
                let decision = profiles ? configuredChestDecision(this.offer.cards, profiles, owned, scores,
                    this.settings.chestReroll, this.game.perksLeft?.reroll || 0, this.settings.qualityFirst, this.settings.learnFirst) : { action: 'wait' };
                if (this.tryCardControls('chest', profiles, decision)) return;
                decision = this.withLockedRerollFallback(decision, 'chest', owned);
                decision = this.withExhaustedChoiceFallback(decision, 'chest', profiles, cards);
                if (decision.action === 'reroll') { this.rerollCurrentOffer('寶箱'); return; }
                if (decision.action === 'wait') {
                    this.status = '寶箱沒有合適選項，等待調整道具或神祇配置';
                    this.logChoiceWait('chest', profiles);
                    return;
                }
                index = decision.index;
                qualityFallback = Boolean(decision.fallback);
                exhaustedFallback = Boolean(decision.exhausted);
                this.status = exhaustedFallback ? '重抽／放逐不可用，備援選道具'
                    : qualityFallback ? '尚未解鎖重抽，依最高品質選道具' : this.settings.learnFirst && !owned.get(this.offer.cards[index].slot)
                    ? '先補齊本局道具欄位' : '依配置升級或替換本局道具';
            } else if (kind === 'roulette') {
                this.status = '等待劇情物品揭示';
                if (now - this.offer.at < 7000) return;
            }
            const selectedCard = this.offer?.cards?.[index];
            const slot = cards[index].closest('.pk-slot');
            if (slot?.classList.contains('asking')) this.click(slot.querySelector('[data-yes]'), 400);
            else if (this.click(cards[index], 800)) {
                const quality = selectedCard && Number.isInteger(selectedCard.quality ?? selectedCard.rarity) ? `［${QUALITY_NAMES[cardQuality(selectedCard)]}］` : '';
                this.log(`${exhaustedFallback ? '重抽／放逐不可用，放寬❌備援：' : qualityFallback ? '未解鎖重抽，最高品質備援：' : '選擇 '}${quality}${cards[index].querySelector('.pk-name')?.textContent || index + 1}`);
            }
        }

        withLockedRerollFallback(decision, kind, owned) {
            if (decision.action === 'pick' || !this.settings.fallbackLockedReroll || !rerollIsLocked(this.game)) return decision;
            const index = highestQualityChoice(this.offer?.cards || [], kind, owned, this.settings.learnFirst);
            return index >= 0 ? { action: 'pick', index, fallback: true } : decision;
        }

        withExhaustedChoiceFallback(decision, kind, profiles, elements = []) {
            // Preserve strict picks, whole rerolls and the user's early skill
            // restart. Locked-reroll behavior retains its separate preference.
            if (decision.action !== 'wait' || !this.settings.fallbackExhaustedChoices || !profiles || rerollIsLocked(this.game)
                || !eliminationChoicesExhausted(this.game, kind, this.offer?.cards || [])) return decision;
            const scores = kind === 'chest' ? this.offer.cards.map((card, index) => elements[index] ? this.chestScore(card, elements[index]) : -Infinity) : [];
            const index = exhaustedChoice(this.offer.cards, kind, profiles, this.game, this.settings, scores);
            return index >= 0 ? { action: 'pick', index, exhausted: true } : decision;
        }

        logChoiceWait(kind, profiles) {
            const session = this.cardControlSession;
            if (!session || !this.offer) return;
            const reasons = this.offer.cards.map(card => {
                const id = kind === 'skill' ? skillProfileId(card, this.game.basicAttack) : card.item;
                const profile = kind === 'skill' ? profiles : profiles?.[card.slot];
                const catalog = kind === 'skill' ? this.skillContext?.catalog : this.chestContext?.groups?.[card.slot];
                const name = catalog?.find(entry => entry.id === id)?.name || id;
                return `${name}：${!profile ? '配置未讀取' : profile.excluded.includes(id) ? '❌ 已排除'
                    : !profile.order.includes(id) ? '未列入配置' : '不符合替換條件'}`;
            });
            const left = this.game.perksLeft || {};
            const message = `${reasons.join('；')}。剩餘重抽全部 ${left.reroll || 0}／單張 ${left.reroll_card || 0}／放逐 ${left.banish || 0}／專注 ${left.focus || 0}`
                + (this.settings.cardActionLimit <= 0 ? '；單張自動操作上限為 0，已關閉' : '；僅使用遊戲允許且有助於配置的操作，專注需先出現偏好卡');
            if (session.waitMessage !== message) { session.waitMessage = message; this.log(message); }
        }

        tryCardControls(kind, profiles, decision) {
            const session = this.cardControlSession;
            const plans = cardControlPlans(this.game, kind, this.offer.cards, profiles, this.settings, decision, session);
            if (!plans.length || document.querySelector('#pk-cards .pk-slot.asking')) return false;
            const labels = { reroll_card: '單張重抽', banish: '放逐', focus: '專注' };
            const matches = { reroll_card: /重抽|reroll/i, banish: /放逐|banish/i, focus: /專注|focus/i };
            for (const plan of plans) {
                const key = `${this.offer.serial}:${plan.index}:${plan.action}`;
                if (session.failed.has(key)) continue;
                const card = this.offer.cards[plan.index];
                const ordinal = nativeCardActions(this.game, kind, card).indexOf(plan.action);
                if (ordinal < 0) continue;
                const button = document.querySelector(`#pk-cards .pk-act[data-act="${plan.index}:${ordinal}"]`);
                if (!button || button.disabled || !this.visible(button) || !matches[plan.action].test(button.textContent)) continue;
                this.status = `${kind === 'skill' ? '技能' : '寶箱'}${labels[plan.action]}（剩餘 ${this.game.perksLeft[plan.action]} 次）`;
                const before = this.game.perksLeft[plan.action];
                let clicked;
                session.preferenceAction = decision.action === 'pick';
                try { clicked = this.click(button, 850); }
                finally { session.preferenceAction = false; }
                if (clicked && this.game.perksLeft[plan.action] === before) {
                    session.failed.add(key);
                    this.log(`${labels[plan.action]}按鈕未生效，本次選牌略過此操作`);
                }
                // A valid desired action may still be waiting for click cooldown.
                return true;
            }
            return false;
        }

        rerollCurrentOffer(label) {
            this.status = `${label}無合適選項，重抽全部（剩餘 ${this.game.perksLeft.reroll} 次）`;
            const reroll = document.querySelector('#pk-bar [data-act="bar:0"]');
            if (!reroll) throw new Error('找不到「重抽全部」按鈕，請更新腳本介面');
            this.click(reroll);
        }

        restartForSkillBuild() {
            if (this.isPartyRun()) { this.status = '組隊中停用個人開場重開，依備援選牌設定處理'; return; }
            const game = this.game;
            if (this.retryGame === game) return;
            if (typeof game.events.onGameOver !== 'function') throw new Error('目前版本無法正常結束遠征');
            this.cancelMovement();
            this.retryGame = game;
            this.offer = null;
            this.cardControlSession = null;
            this.status = '前兩分鐘重抽耗盡，重新遠征';
            this.log(`開場 ${Math.floor(game.time)} 秒沒有可選技能，結束本場並重新遠征`);
            // Match the native game-over transition before its normal callback
            // submits the run and opens the server-backed settlement screen.
            game.state = 'over';
            game.events.onGameOver(false);
        }

        calculateStats(items) {
            const game = this.game;
            const helpers = this.bindings;
            if (!['createStats', 'applyRank', 'finalizeStats', 'classById'].every(name => typeof helpers[name] === 'function')) return null;
            if (!helpers.skills || typeof helpers.levelDamage !== 'number' || typeof helpers.levelHp !== 'number') return null;
            const stats = helpers.createStats(game.classDef);
            game.loadout?.applyStats(stats);
            items.apply(stats);
            for (const [id, rank] of game.passives) helpers.skills[id]?.passive?.(stats, rank);
            const agiDex = game.buffValue('agiDex');
            stats.agi *= 1 + agiDex;
            stats.dex *= 1 + agiDex;
            const promotion = game.promotion ?? game.look?.promotion;
            helpers.applyRank(stats, (promotion ? helpers.classById(promotion) : game.classDef).rank);
            stats.damageMult *= 1 + helpers.levelDamage * Math.max(0, game.level - 1);
            stats.maxHp *= 1 + helpers.levelHp * Math.max(0, game.level - 1);
            helpers.finalizeStats(stats);
            return stats;
        }

        dpsEstimate(items) {
            const game = this.game;
            const stats = this.calculateStats(items);
            if (!stats) return null;
            const view = Object.create(game);
            view.stats = stats;
            view.runItems = items;
            let total = 0;
            for (const weapon of game.weapons) {
                if (weapon.type === 'buff' || typeof weapon.mod !== 'function') continue;
                const mod = weapon.mod(view);
                const currentMod = weapon.mod(game);
                const baseWeight = Array.from(game.dmgLog.get(weapon.id)?.values() ?? []).reduce((sum, value) => sum + value, 0) || 1;
                const cooldown = Math.max(0.15, weapon.finalCooldown(view) + weapon.finalCastTime(view));
                const currentCooldown = Math.max(0.15, weapon.finalCooldown(game) + weapon.finalCastTime(game));
                const quantity = typeof weapon.count === 'function' ? Math.max(1, weapon.count(view)) : 1 + Math.max(0, mod.count);
                const currentQuantity = typeof weapon.count === 'function' ? Math.max(1, weapon.count(game)) : 1 + Math.max(0, currentMod.count);
                const targets = 1 + Math.max(0, mod.targets) * 0.35;
                const currentTargets = 1 + Math.max(0, currentMod.targets) * 0.35;
                const ratio = Math.max(0.01, 1 + mod.dmg) / Math.max(0.01, 1 + currentMod.dmg)
                    * currentCooldown / cooldown * quantity / currentQuantity * targets / currentTargets;
                total += baseWeight * ratio;
            }
            const critical = 1 + Math.max(0, stats.critChance) * Math.max(0, stats.critMult - 1);
            const repeat = 1 + Math.max(0, stats.doubleChance);
            return total * stats.damageMult * critical * repeat;
        }

        chestScore(card, element) {
            try {
                const items = new this.game.runItems.constructor();
                items.slots = new Map(Array.from(this.game.runItems.slots, ([slot, item]) => [slot, { ...item, vals: [...item.vals] }]));
                items.choose(card);
                const estimate = this.dpsEstimate(items);
                if (Number.isFinite(estimate)) return estimate + (card.quality || 0) * 1e-8;
            } catch (error) { this.log(`DPS 估算改用物品說明，${error.message}`); }
            const text = normalized(element.textContent);
            let score = Number(card.quality) || 0;
            for (const [pattern, weight] of [[/傷害|damage|daño|dano/, 100], [/急速|haste|celeridad|冷卻/, 90], [/爆擊|critical|cr[ií]tico/, 70], [/matk|atk|攻擊/, 60], [/投射物|projectile|proyectil/, 60]]) if (pattern.test(text)) score += weight;
            return score;
        }

        handleServerSettlement() {
            if (typeof document === 'undefined' || !document) return false;
            const box = document.getElementById('go-server-loot');
            if (!box || typeof box.querySelectorAll !== 'function') return false;
            const restart = document.getElementById('btn-restart');
            const exitLabels = new Set(['離開', '离开', 'leave', 'exit', 'salir', 'sair']);
            if (restart && !restart.disabled && exitLabels.has(normalized(restart.textContent))) {
                this.stop('伺服器結算未完成，請重新連線；戰利品可向普隆德拉郵差確認');
                return true;
            }
            const rows = Array.from(box.querySelectorAll('.gl-row'));
            for (const row of rows) {
                const need = row.querySelector('button[data-c="need"]');
                const greed = row.querySelector('button[data-c="greed"]');
                const button = need && !need.disabled ? need : greed && !greed.disabled ? greed : null;
                if (!button) continue;
                this.restartAt = 0;
                if (!this.settings.settlementLoot) {
                    this.status = '結算戰利品待手動分配，完成後繼續';
                    return true;
                }
                this.status = button === need ? '結算分配：依遊戲排序選 Need' : '結算分配：選 Greed';
                if (this.click(button, 650)) this.log(`${button === need ? 'Need' : 'Greed'}：${row.querySelector('.gl-name b')?.textContent || '結算物品'}`);
                // Native rendering removes picked buttons and immediately
                // decrements its shared two-Need budget, including in-flight picks.
                return true;
            }
            if (restart?.disabled) {
                this.restartAt = 0;
                this.status = rows.length ? '等待隊伍分配與伺服器入庫完成' : '等待伺服器結算戰利品';
                return true;
            }
            return false;
        }

        handleGameOver(now) {
            this.cancelMovement();
            // Finish server settlement even on the last allowed run or when
            // repeat is off. Never leave an unfinished Need/Greed vote early.
            if (this.handleServerSettlement()) return;
            const game = this.game;
            const retry = Boolean(game && this.retryGame === game);
            if (game && !this.finishedGames.has(game)) {
                this.finishedGames.add(game);
                this.clearPickupGoal();
                this.clearFriendlyAreas();
                this.clearRiskMotion();
                this.bellMode = null;
                this.blockedPickups = new WeakMap();
                if (retry) { this.retryCount += 1; this.log(`技能配置重新出征，第 ${this.retryCount} 次`); }
                else { this.runCount += 1; this.log(`第 ${this.runCount} 場結束`); }
            }
            const finished = !retry && (!this.settings.repeat || this.settings.maxRuns > 0 && this.runCount >= this.settings.maxRuns);
            const party = this.isPartyRun();
            if (finished && !party) {
                this.stop(`已完成 ${this.runCount} 場`);
                return;
            }
            if (!this.restartAt) this.restartAt = now + (retry ? 500 : this.settings.repeatDelay * 1000);
            this.status = `${Math.max(0, Math.ceil((this.restartAt - now) / 1000))} 秒後${party ? '返回大廳' : '再次出征'}`;
            if (now < this.restartAt) return;
            if (this.click(document.getElementById('btn-restart'))) {
                this.restartAt = 0;
                this.clearPickupGoal();
                this.game = null;
                this.offer = null;
                this.retryGame = null;
                this.runMode = null;
                this.partyFlow.phase = 'idle'; this.partyFlow.attempts = 0;
                if (finished && party) this.stop(`已完成 ${this.runCount} 場，返回大廳後停止組隊自動準備`);
            }
        }

        activeHazards() {
            const game = this.game;
            this.zones = this.zones.filter(hazard => !hazard.dead);
            this.arrows = this.arrows.filter(arrow => game.fx.includes(arrow.fx));
            return this.zones.filter(hazard => {
                if (!point(hazard.zone) || hazard.zone.alpha < 0.08 || !(hazard.zone.progress > 0)) return false;
                return !game.story?.locks?.some(lock => lock.ring === hazard.zone);
            });
        }

        readThreats(speed, closeEngagement = false, resourceRadius = 0) {
            const game = this.game;
            const radius = Math.max(600, speed * 2, resourceRadius > 0 ? resourceRadius + 350 : 0);
            return game.enemies.filter(enemy => !enemy.dead && !enemy.removed && !(enemy.hiddenUntil > game.time)
                && point(enemy) && distance(enemy, game.player) < radius)
                .sort((a, b) => distance(a, game.player) - distance(b, game.player)).slice(0, resourceRadius > 0 ? 240 : 100).map(enemy => {
                    const length = distance(enemy, game.player) || 1;
                    const stopped = enemy.busyUntil > game.time || enemy.stopped?.(game.time);
                    const velocity = stopped ? 0 : (enemy.def.speed || 0) * (enemy.speedMult || 1) * this.bindings.speedUnits * (game.difficulty?.speed || 1);
                    const contact = (enemy.def.radius || 20) + 16;
                    const close = closeEngagement && !enemy.def.boss && !enemy.elite;
                    return { x: enemy.x, y: enemy.y,
                        vx: (game.player.x - enemy.x) / length * velocity,
                        vy: (game.player.y - enemy.y) / length * velocity,
                        contact, radius: contact + (close ? Math.min(18, this.settings.safetyMargin) : this.settings.safetyMargin),
                        ...(close ? { predictionHorizon: Math.min(0.3, this.settings.lookahead) } : {}) };
                });
        }

        clearPickupGoal() {
            this.goal = null;
            this.resourceTarget = null;
            this.goalSince = 0;
            this.goalOrigin = null;
        }

        clearRiskMotion() {
            this.motionAnchor = null;
            this.escapePoint = null;
            this.escapePointUntil = 0;
            this.wasTanking = false;
            this.cornerRetreat = null;
            this.lastCornerSearch = -Infinity;
            this.tankChestTarget = null;
            this.recoveryRushTarget = null;
            this.recoveryRushSource = null;
            this.observedHp = null;
            this.recoveryCredit = null;
            this.pendingRecovery = null;
            this.openingMode = '';
        }

        cornerRetreatGoal(now, speed, threats, zones, navigation, goal, prioritizeChest = false) {
            const game = this.game;
            const release = () => {
                if (this.cornerRetreat) { this.cancelMovement(); this.lastMoveIssued = -Infinity; }
                this.cornerRetreat = null;
                return null;
            };
            if (prioritizeChest || !navigation?.avoidCorners || !threats.length) return release();
            const here = navigationRisk(game.player, navigation);
            const ahead = goal && distance(game.player, goal) < navigation.radius * 2.5 ? navigationRisk(goal, navigation) : null;
            const pressured = here.pressure >= 0.8 && here.space.openness < 0.68 && (here.free <= 8 || here.space.arc < 0.38);
            const dangerousGoal = ahead && ahead.pressure >= 1.1 && ahead.space.openness < 0.55 && ahead.free <= 5
                && ahead.space.openness < here.space.openness - 0.1;
            if (!pressured && !dangerousGoal && (!this.cornerRetreat || now - this.cornerRetreat.since > 1800)) return release();
            if (!this.cornerRetreat) {
                this.cornerRetreat = { since: now, destination: null, replanAt: 0 };
                this.cancelMovement();
                this.lastMoveIssued = -Infinity;
                this.log(dangerousGoal ? '敵群正在封住靠牆目標的退路，先往開闊處調整位置' : '角落／狹路出口受到敵群壓迫，提早撤離');
            }
            const retreat = this.cornerRetreat;
            if ((!retreat.destination || now >= retreat.replanAt || distance(game.player, retreat.destination) < 45)
                && now - this.lastCornerSearch >= 650) {
                this.lastCornerSearch = now;
                const route = findRetreatRoute(game.player, speed, threats, zones, this.arrows,
                    game.bounds, game.walk, this.settings, navigation);
                retreat.destination = route?.destination || null;
                retreat.replanAt = now + (route ? 1800 : 650);
            }
            this.clearPickupGoal();
            const path = retreat.destination && navigationPath(game.player, retreat.destination, game.walk);
            if (retreat.destination && !path) { retreat.destination = null; retreat.replanAt = 0; }
            return { waypoint: path?.find(p => distance(p, game.player) > 10) || null, blocked: !path };
        }

        motionIsStalled(now, needsMovement) {
            const player = this.game.player;
            if (!needsMovement) { this.motionAnchor = null; return false; }
            if (!this.motionAnchor || distance(player, this.motionAnchor) > 16) {
                this.motionAnchor = { x: player.x, y: player.y, at: now };
                return false;
            }
            return now - this.motionAnchor.at >= 1500;
        }

        chooseGoal(now, skipOrdinary = false, opening = false, collection = null) {
            const game = this.game;
            const available = game.pickups.filter(pickup => pickup && typeof pickup === 'object' && point(pickup)
                && typeof pickup.kind === 'string' && !pickup.dead && !pickup.magnet
                && (this.blockedPickups.get(pickup) || 0) < now);
            const farm = resourceFarmPlan(game, this.settings, available, collection, this.goal);
            this.resourceTarget = farm;
            const candidates = available.filter(pickup => !ordinaryPickup(pickup) || !farm && !skipOrdinary)
                .map(pickup => ({ pickup, score: pickupScore(pickup, game, this.settings, opening) }))
                .filter(entry => Number.isFinite(entry.score));
            if (farm) candidates.push(farm);
            candidates.sort((a, b) => b.score - a.score);
            const selected = candidates[0]?.pickup;
            // No pickup is a normal idle/story state. It must never enter the
            // stuck-target branch or become a WeakMap key.
            if (!selected) {
                this.clearPickupGoal();
                return point(game.story?.target) ? game.story.target : null;
            }
            if (this.goal === selected && this.goalOrigin && now - this.goalSince > 2500) {
                if (distance(game.player, this.goalOrigin) < 8) {
                    this.blockedPickups.set(selected, now + 10000);
                    this.clearPickupGoal();
                    return null;
                }
                this.goalOrigin = { x: game.player.x, y: game.player.y };
                this.goalSince = now;
            }
            if (this.goal !== selected) {
                this.goal = selected;
                this.goalSince = now;
                this.goalOrigin = { x: game.player.x, y: game.player.y };
            }
            return { x: selected.x, y: selected.y + 20 };
        }

        handleBellMechanic(bell, now, speed, threats, zones) {
            const game = this.game;
            if (this.bellMode?.actor !== bell.actor || this.bellMode.sealed !== bell.sealed) {
                this.cancelMovement();
                this.clearRiskMotion();
                this.lastMoveIssued = -Infinity;
                this.log(bell.sealed ? '月夜貓封印鐘：優先接近守衛，擊殺解封後進入鐘下'
                    : '月夜貓鐘聲：暫停拾取，優先進入鐘下安全區');
            }
            this.bellMode = { actor: bell.actor, sealed: bell.sealed };
            this.clearPickupGoal();
            const guardian = bell.sealed ? game.enemies.filter(enemy => enemy?.def?.id === 'cat_o_nine_tail'
                && !enemy.dead && !enemy.removed && !(enemy.hiddenUntil > game.time) && point(enemy))
                .sort((a, b) => distance(a, bell) - distance(b, bell))[0] : null;
            const inside = distance(game.player, bell) < bell.radius;
            const destination = bellDestination(game.player, bell, guardian);
            const route = bellRoute(game.player, destination, bell, game.bounds, game.walk);
            const containment = bell.sealed ? null : { x: bell.x, y: bell.y, radius: bell.radius - 6, triggerRadius: bell.radius };
            let motion = planMotion(game.player, route.waypoint, speed, threats, zones, this.arrows,
                game.bounds, game.walk, this.settings, null, false, containment, { avoidCorners: false });
            if (route.waypoint && (!inside || bell.sealed && guardian)) {
                const progress = motion.point ? distance(game.player, route.waypoint) - distance(motion.point, route.waypoint) : 0;
                const expected = Math.min(speed * this.settings.lookahead, distance(game.player, route.waypoint));
                if (bell.charge >= 0.8 || progress < expected * 0.25) {
                    // Entering the only shelter is a survival objective even
                    // below the optional loot-rushing HP threshold. Preserve
                    // normal terrain/path checks and circle containment.
                    const entry = planMotion(game.player, route.waypoint, speed, threats, zones, this.arrows,
                        game.bounds, game.walk, this.settings, null, true, containment, { avoidCorners: false });
                    if (entry.point && distance(entry.point, route.waypoint) < distance(game.player, route.waypoint) - 3) motion = entry;
                }
            }
            if (motion.point) {
                if (now - this.lastMoveIssued > 180) { game.moveTo(motion.point.x, motion.point.y); this.lastMoveIssued = now; }
            } else this.cancelMovement();
            this.status = bell.sealed ? guardian ? '封印鐘：接近守衛並自動攻擊' : '封印鐘：接近鐘下，等待守衛或解封'
                : route.blocked ? '鐘下路徑受阻，優先尋找可通行入口'
                : inside ? motion.danger ? '鐘下避險：留在圈內閃躲' : '鐘下安全區：等待鐘聲'
                : '躲避全畫面攻擊：前往鐘下';
        }

        handleCombat(now) {
            const game = this.game;
            if (game.endless) { this.stop('目前為無盡之塔，請返回一般遠征使用'); return; }
            const speed = game.classDef.speed * this.bindings.speedUnits * game.stats.speedMult * (1 + game.buffValue('speed')) * (1 - game.buffValue('slow'));
            if (!Number.isFinite(speed) || speed <= 0 || !game.bounds) throw new Error('無法讀取移動狀態');
            const recentRecovery = this.recoveryRushSource || (this.pendingRecovery?.until > game.time ? this.pendingRecovery.key : null);
            if (Number.isFinite(this.observedHp) && game.hp > this.observedHp + 0.5 && recentRecovery
                && canTankDamage(game, this.settings)) {
                this.recoveryCredit = { key: recentRecovery, until: game.time + 1.5 };
            }
            this.observedHp = game.hp;
            if (!canTankDamage(game, this.settings) || this.recoveryCredit?.until <= game.time) this.recoveryCredit = null;
            if (!canTankDamage(game, this.settings) || this.pendingRecovery?.until <= game.time) this.pendingRecovery = null;
            const zones = this.activeHazards();
            const bell = selectBellShelter(game.player, readBellShelters(game));
            const opening = !bell && openingFarmActive(game, this.settings);
            const closeEngagement = opening && game.hp / game.stats.maxHp >= 0.6;
            const threats = this.readThreats(speed, closeEngagement, this.settings.resourceFarm ? this.settings.resourceLootRadius : 0);
            if (bell) { this.handleBellMechanic(bell, now, speed, threats, zones); return; }
            if (this.bellMode) {
                this.bellMode = null;
                this.cancelMovement();
                this.clearRiskMotion();
                this.lastMoveIssued = -Infinity;
                this.log('鐘聲機制結束，恢復一般避險與拾取');
            }
            const openingMode = opening ? closeEngagement ? 'engage' : 'collect' : '';
            if (this.openingMode !== openingMode) {
                this.cancelMovement();
                this.lastMoveIssued = -Infinity;
                this.openingMode = openingMode;
            }
            this.hookGroundSkills(game);
            const friendlyArea = this.settings.stayInGroundAoe ? selectFriendlyArea(game.player, this.activeFriendlyAreas()) : null;
            let goal = this.chooseGoal(now, Boolean(friendlyArea) && !opening, opening,
                { speed, threats, zones, arrows: this.arrows, recoveryFields: this.recoveryFields, recoveryCredit: this.recoveryCredit });
            let stayingInArea = Boolean(friendlyArea && !this.goal && !point(game.story?.target));
            if (stayingInArea) goal = friendlyAreaPoint(game.player, friendlyArea);
            if (goal && game.walk) {
                const [x, y] = game.walk.nearestWalkable(goal.x, goal.y);
                goal = { x, y };
                const path = game.walk.pathTo(game.player.x, game.player.y, goal.x, goal.y);
                const waypoint = path?.find(position => distance(position, game.player) > 8);
                if (waypoint) goal = waypoint;
                else if (distance(goal, game.player) > 35) goal = null;
            }
            const navigation = navigationContext(speed, threats, game.bounds, game.walk, this.settings);
            const assistRoute = goal && this.goal && canTankDamage(game, this.settings)
                ? this.resourceTarget?.pickup === this.goal ? this.resourceTarget.route : safeResourceRoute(game, this.goal,
                    { speed, threats, zones, arrows: this.arrows, lookahead: this.settings.lookahead,
                        radius: Math.max(this.settings.resourceLootRadius, this.settings.specialLootRadius), allowRecovery: true }, 30)
                : null;
            let recovery = goal && assistRoute
                ? recoveryOpportunity(game, this.settings, this.goal, speed, this.recoveryFields, assistRoute, this.recoveryCredit) : null;
            const tankChest = Boolean(goal && recovery && canTankChest(game, this.settings, this.goal));
            const retreat = this.cornerRetreatGoal(now, speed, threats, zones, navigation, goal);
            if (retreat) { goal = retreat.waypoint; stayingInArea = false; navigation.retreat = true; recovery = null; }
            const chestTarget = tankChest && !retreat ? this.goal : null;
            if (this.tankChestTarget !== chestTarget) {
                // Apply HP, funds and target changes immediately, including
                // safe approaches that have not needed damage-taking yet.
                this.cancelMovement();
                this.lastMoveIssued = -Infinity;
                this.escapePoint = null;
                this.escapePointUntil = 0;
                this.motionAnchor = null;
                this.tankChestTarget = chestTarget;
                if (chestTarget) this.log(`HP ${Math.round(game.hp / game.stats.maxHp * 100)}% 達門檻，${recovery.name} 支援接近寶箱`);
            }
            const recoveryTarget = recovery ? this.goal : null;
            if (recovery && !this.recoveryCredit) this.pendingRecovery = { key: recovery.key, until: game.time + 1.2 };
            if (this.recoveryRushTarget !== recoveryTarget || this.recoveryRushSource !== (recovery?.key || null)) {
                this.cancelMovement();
                this.lastMoveIssued = -Infinity;
                this.escapePoint = null;
                this.escapePointUntil = 0;
                this.motionAnchor = null;
                this.recoveryRushTarget = recoveryTarget;
                this.recoveryRushSource = recovery?.key || null;
            }
            // Healing may permit damage, but never disables dead-end prevention.
            const movementNavigation = navigation;
            movementNavigation.openingFarm = closeEngagement && !retreat && !tankChest && !valuablePickup(this.goal)
                && threats.every(threat => Number.isFinite(threat.predictionHorizon));
            const motionThreats = retreat ? this.readThreats(speed) : threats;
            let motion = planMotion(game.player, goal, speed, motionThreats, zones, this.arrows, game.bounds, game.walk, this.settings,
                stayingInArea ? friendlyArea : null, false, null, movementNavigation);
            const stalled = this.motionIsStalled(now, Boolean(motion.point || motion.danger));
            let tanking = '';
            if (canTankDamage(game, this.settings)) {
                const progress = goal && motion.point ? distance(game.player, goal) - distance(motion.point, goal) : 0;
                const desiredProgress = goal ? Math.min(speed * this.settings.lookahead, distance(game.player, goal)) : 0;
                if (goal && (recovery || retreat && progress < desiredProgress * 0.25)) {
                    const rush = planMotion(game.player, goal, speed, motionThreats, zones, this.arrows, game.bounds, game.walk, this.settings, null, true, null, movementNavigation);
                    const rushProgress = rush.point ? distance(game.player, goal) - distance(rush.point, goal) : 0;
                    if (rush.point && rushProgress > Math.max(3, progress + 3)) { motion = rush; tanking = retreat ? 'escape' : 'recovery'; }
                }
                if (!tanking && motion.danger && (!motion.point || stalled)) {
                    if (!this.escapePoint || now >= this.escapePointUntil || distance(game.player, this.escapePoint) < 30) {
                        this.escapePoint = findEscapePoint(game.player, speed, threats, zones, this.arrows, game.bounds, game.walk, this.settings);
                        this.escapePointUntil = now + 2000;
                    }
                    if (this.escapePoint) {
                        const escape = planMotion(game.player, this.escapePoint, speed, motionThreats, zones, this.arrows, game.bounds, game.walk, this.settings, null, true, null, navigation);
                        if (escape.point) { motion = escape; tanking = 'escape'; }
                    }
                }
            } else { this.escapePoint = null; }
            if (Boolean(tanking) !== this.wasTanking) {
                this.cancelMovement();
                this.lastMoveIssued = -Infinity;
                if (tanking) this.log(`HP ${Math.round(game.hp / game.stats.maxHp * 100)}%，${tanking === 'recovery' ? `回血支援換血拾取：${recovery.name}` : tanking === 'loot' ? '硬扛搶拾' : '硬扛脫困'}（最低 ${this.settings.tankHpPercent}%）`);
            }
            this.wasTanking = Boolean(tanking);
            if (motion.point) {
                // Each destination is reached with the game's normal collision and movement speed.
                if (now - this.lastMoveIssued > 180) { game.moveTo(motion.point.x, motion.point.y); this.lastMoveIssued = now; }
                this.status = tanking ? tanking === 'recovery' ? `回血支援換血拾取 ${PICKUP_NAMES[this.goal.kind] || '道具'}` : tanking === 'loot' ? `硬扛搶拾 ${PICKUP_NAMES[this.goal.kind] || '掉落'}` : '硬扛脫困'
                    : retreat ? '預防包圍：撤往開闊處' : motion.danger ? opening ? '開場短距離避險' : '近身避險'
                    : this.goal && this.resourceTarget?.pickup === this.goal ? this.resourceTarget.funding
                        ? `湊開箱費 ${game.zeny}/${this.resourceTarget.budget.cost}：順路收集金幣／經驗`
                        : '快速發育：順路收集金幣／經驗'
                    : this.goal ? `${opening && ordinaryPickup(this.goal) ? '開場發育：拾取' : '拾取'} ${PICKUP_NAMES[this.goal.kind] || '道具'}`
                    : stayingInArea ? `回到 ${friendlyArea.name} 範圍` : '前往劇情目標';
            } else {
                this.cancelMovement();
                this.status = retreat ? retreat.blocked ? '退路受阻，尋找可通行出口' : '保留退路，等待敵群空隙'
                    : motion.danger ? '避險路線受阻，等待空隙' : stayingInArea ? `留在 ${friendlyArea.name} 範圍` : opening ? '開場站定攻擊，等待附近掉落' : '站定攻擊';
            }
        }

        bindManualControls() {
            window.addEventListener('keydown', event => {
                if (event.key !== 'F8') return;
                event.preventDefault();
                if (!event.repeat) this.enabled ? this.stop() : this.start();
            }, true);
            document.addEventListener('input', event => {
                if (!event.isTrusted || !event.target.matches?.('#npc-text .diff input[data-key]')) return;
                this.settings.difficulty[event.target.dataset.key] = Number(event.target.value);
                this.saveSettings();
                this.refreshInputs();
            });
        }

        applyPanelLayout() {
            const layout = panelLayout(this.settings.panel, { width: window.innerWidth, height: window.innerHeight });
            Object.assign(this.host.style, {
                left: `${layout.x}px`, top: `${layout.y}px`, width: `${layout.width}px`, height: `${layout.height}px`,
            });
            const minimized = this.settings.panel.minimized;
            this.ui.querySelector('.panel').classList.toggle('minimized', minimized);
            const toggle = this.ui.querySelector('#ra-collapse');
            toggle.textContent = minimized ? '展開' : '縮小';
            toggle.title = minimized ? '展開面板' : '縮小面板，自動操作會繼續';
            toggle.setAttribute('aria-expanded', String(!minimized));
            return layout;
        }

        bindPanelControls() {
            const header = this.ui.querySelector('header');
            const resize = this.ui.querySelector('#ra-resize');
            const begin = (event, kind, target) => {
                if (event.button !== 0 || event.isPrimary === false || this.panelGesture) return;
                if (kind === 'move' && event.target.closest('button')) return;
                event.preventDefault();
                event.stopPropagation();
                const layout = this.applyPanelLayout();
                this.panelGesture = { kind, id: event.pointerId, target, startX: event.clientX, startY: event.clientY, layout };
                this.settings.panel.x = layout.x;
                this.settings.panel.y = layout.y;
                this.ui.querySelector('.panel').classList.add('dragging');
                try { target.setPointerCapture(event.pointerId); } catch { /* Synthetic test pointers have no capture target. */ }
            };
            const move = event => {
                const gesture = this.panelGesture;
                if (!gesture || event.pointerId !== gesture.id) return;
                event.preventDefault();
                event.stopPropagation();
                const dx = event.clientX - gesture.startX;
                const dy = event.clientY - gesture.startY;
                if (gesture.kind === 'move') {
                    this.settings.panel.x = gesture.layout.x + dx;
                    this.settings.panel.y = gesture.layout.y + dy;
                } else {
                    const availableWidth = Math.max(1, window.innerWidth - gesture.layout.x - 8);
                    const availableHeight = Math.max(1, window.innerHeight - gesture.layout.y - 8);
                    this.settings.panel.width = clamp(gesture.layout.width + dx, Math.min(310, availableWidth), Math.min(1600, availableWidth));
                    this.settings.panel.height = clamp(gesture.layout.height + dy, Math.min(250, availableHeight), Math.min(1400, availableHeight));
                }
                const layout = this.applyPanelLayout();
                this.settings.panel.x = layout.x;
                this.settings.panel.y = layout.y;
            };
            const finish = event => {
                const gesture = this.panelGesture;
                if (!gesture || event.pointerId !== gesture.id) return;
                event.stopPropagation();
                this.panelGesture = null;
                this.ui.querySelector('.panel').classList.remove('dragging');
                try { gesture.target.releasePointerCapture(gesture.id); } catch { /* The browser may have already released it. */ }
                this.saveSettings();
            };
            header.addEventListener('pointerdown', event => begin(event, 'move', header));
            resize.addEventListener('pointerdown', event => begin(event, 'resize', resize));
            for (const handle of [header, resize]) {
                handle.addEventListener('pointermove', move);
                handle.addEventListener('pointerup', finish);
                handle.addEventListener('pointercancel', finish);
                handle.addEventListener('lostpointercapture', finish);
            }
            resize.onkeydown = event => {
                if (!['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(event.key)) return;
                event.preventDefault(); event.stopPropagation();
                const step = event.shiftKey ? 40 : 10;
                const layout = this.applyPanelLayout();
                this.settings.panel.x = layout.x; this.settings.panel.y = layout.y;
                this.settings.panel.width = clamp(layout.width + (event.key === 'ArrowRight' ? step : event.key === 'ArrowLeft' ? -step : 0), 310, Math.max(310, window.innerWidth - layout.x - 8));
                this.settings.panel.height = clamp(layout.height + (event.key === 'ArrowDown' ? step : event.key === 'ArrowUp' ? -step : 0), 250, Math.max(250, window.innerHeight - layout.y - 8));
                this.saveSettings(); this.applyPanelLayout();
            };
            this.ui.querySelector('#ra-collapse').onclick = () => {
                this.settings.panel.minimized = !this.settings.panel.minimized;
                this.saveSettings(); this.applyPanelLayout();
            };
            this.ui.querySelector('#ra-panel-reset').onclick = () => {
                this.settings.panel = { ...PANEL_DEFAULTS };
                this.saveSettings(); this.applyPanelLayout();
            };
            window.addEventListener('resize', () => this.applyPanelLayout(), { passive: true });
            this.applyPanelLayout();
        }

        buildPanel() {
            this.host = document.createElement('div');
            this.host.id = 'ro-auto-panel';
            this.host.style.cssText = 'position:fixed;z-index:2147483645';
            this.ui = this.host.attachShadow({ mode: 'open' });
            this.ui.innerHTML = `
                <style>
                    :host{all:initial;color:#e6edf5;font:16px/1.55 system-ui,sans-serif}
                    *{box-sizing:border-box} .panel{position:relative;display:flex;flex-direction:column;width:100%;height:100%;background:#13202f;border:1px solid #50677e;border-radius:10px;box-shadow:0 6px 28px #0007;overflow:hidden}
                    header{display:flex;flex:none;height:54px;align-items:center;gap:10px;padding:7px 12px;border-bottom:1px solid #34465a;cursor:grab;touch-action:none;user-select:none}
                    header b{white-space:nowrap}header .drag-hint{flex:1;min-width:0;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}.header-actions{display:flex;gap:6px;margin-left:auto}header button{white-space:nowrap}
                    .panel.dragging header{cursor:grabbing}.panel.minimized .body,.panel.minimized .resize-handle,.panel.minimized .drag-hint{display:none}.panel.minimized header{height:100%;border-bottom:0;padding:4px 8px}
                    button,input,select{font:inherit}button{cursor:pointer;background:#2b4259;color:#edf4fb;border:1px solid #536b84;border-radius:5px;padding:5px 10px}
                    button:hover{background:#385777}.primary{background:#1c6c54}.danger{background:#8b353b}
                    header button{font-size:16px;line-height:1.4;padding:4px 8px;min-height:30px}
                    .body{padding:14px 16px 26px;flex:1;min-height:0;overflow-y:auto;overscroll-behavior:contain;overflow-anchor:none;container-type:inline-size}.row{display:flex;flex-wrap:wrap;gap:10px;align-items:center;margin:10px 0}.row>label{flex:1 1 160px;min-width:0}
                    select,input[type=number]{color:#edf4fb;background:#0e1825;border:1px solid #50677e;border-radius:5px;padding:7px 9px;min-height:38px;max-width:100%;width:100%}input[type=number]{width:90px;flex:none}.row>select{flex:0 1 200px;width:200px;min-width:140px}
                    label{display:block;overflow-wrap:break-word}input[type=checkbox]{width:17px;height:17px;vertical-align:-2px;margin-right:5px;accent-color:#8bb6ff}small,.hint{color:#afc0d3;font-size:16px}.hint{margin:5px 0}.connection{overflow-wrap:anywhere}.connection.failed{color:#ffb5a9}details{margin-top:12px;border-top:1px solid #34465a;padding-top:10px}summary{cursor:pointer;font-weight:600}
                    .mode-summary{min-width:0;max-width:100%;font-size:18px;font-weight:600;line-height:1.5;color:#a9caff;overflow-wrap:anywhere}
                    .status{color:#82dabb;white-space:pre-wrap;margin:8px 0}.log{white-space:pre-wrap;font-size:16px;color:#b2c1d0;max-height:140px;overflow:auto}
                    .shortcut{color:#9de4c7;background:#1c3f37;border:1px solid #416e60;border-radius:6px;padding:6px 10px}.shortcut.running{background:#624127;color:#ffe0b1}.hp-row{padding-top:10px;border-top:1px solid #34465a}
                    .hidden{display:none}.stat{color:#aabccf;font-size:16px}
                    .workspace{display:grid;grid-template-columns:minmax(0,1fr);gap:14px;margin-top:16px;align-items:start}.workspace>details{min-width:0;margin:0;border:1px solid #344b61;border-radius:8px;padding:12px;background:#101c2a80}.workspace>details>summary{font-size:17px;color:#c5dcf7}.choice-settings>summary{font-size:16px;color:#afc8e7}
                    @container (min-width:920px){.workspace{grid-template-columns:repeat(2,minmax(0,1fr))}.wide-span{grid-column:1/-1}}
                    [hidden]{display:none!important}
                    .difficulty-row{flex-wrap:nowrap}.difficulty-row label{flex:0 0 94px;min-width:0}.difficulty-row small{display:block;font-size:16px}
                    input[type=range]{flex:1;width:100px;min-width:50px;accent-color:#8bb6ff;margin:0}.difficulty-row output{min-width:40px;text-align:right;color:#a9caff;font-weight:600}
                    .skill-list{max-height:380px;overflow:auto;overscroll-behavior:contain;overflow-anchor:none;margin-top:10px}.skill-row{display:flex;align-items:center;gap:8px;padding:7px 2px;border-bottom:1px solid #304052}
                    .skill-row img{width:34px;height:34px;object-fit:contain;image-rendering:pixelated;flex:none}.skill-name{flex:1;min-width:0;font-size:16px;overflow-wrap:anywhere}.skill-name small{display:block;font-size:16px}
                    .skill-row button{padding:2px;width:32px;height:34px;flex:none}.skill-row button:disabled{opacity:.3;cursor:default}.skill-row.excluded .skill-name{color:#bf9d9d;text-decoration:line-through}
                    .skill-row.excluded img{opacity:.4}.skill-row button[aria-pressed=true]{background:#8b353b;border-color:#bd5a62}.job-label{margin:7px 0;color:#a9caff}
                    [hidden]{display:none!important}.resize-handle{position:absolute;right:1px;bottom:1px;width:21px;height:21px;padding:0;border:0;border-radius:5px;background:#263c50;cursor:nwse-resize;touch-action:none;line-height:21px;color:#b7cce2}
                </style>
                <section class="panel">
                    <header title="拖曳標題列移動面板"><b>RO 自動遠征</b><small class="drag-hint">拖曳移動 · 右下角調整大小</small><div class="header-actions"><button id="ra-panel-reset" title="重設面板位置與大小" aria-label="重設面板位置與大小">↺</button><button id="ra-collapse" aria-controls="ra-body" aria-expanded="true">縮小</button></div></header>
                    <div class="body" id="ra-body">
                        <div class="row"><strong class="shortcut" id="ra-shortcut">F8 開啟自動</strong><span class="mode-summary" id="ra-mode">目前設定：單人 · 等待讀取角色</span></div>
                        <div class="hint connection" id="ra-connection"></div>
                        <div class="status" id="ra-status"></div><div class="stat" id="ra-stat"></div>
                        <div class="row hp-row"><label for="ra-hp">承傷拾取最低 HP</label><input id="ra-hp" type="number" data-setting="tankHpPercent" min="0" max="100" step="1"><span>%</span></div>
                        <div class="hint">HP 達門檻且有沿途補血或可用回血技能時，可承傷湊錢／開箱。自動避開死路；裝備與卡片留待結算。</div>
                        <div class="workspace">
                            <details class="wide-span"><summary>出征與難度</summary>
                                <div class="row"><label for="ra-stage">副本</label><select id="ra-stage"><option value="first">第一個可挑戰副本</option><option value="last">最後一個可挑戰副本</option><option value="${LANTERN_STAGE.id}">${LANTERN_STAGE.name}</option></select></div>
                                <div class="row"><label><input type="checkbox" data-setting="repeat"> 重複出征</label><label for="ra-runs">場數</label><input id="ra-runs" type="number" data-setting="maxRuns" min="0" max="9999"></div>
                                <div class="hint">場數 0 持續出征。F8 開啟時重新計數；一般副本與隊長交談後載入，燈籠節由節慶主持人進場。</div>
                                <div class="hint" id="ra-party-state"></div>
                                <div id="ra-difficulty-controls">
                                ${DIFFICULTY.map(item => `<div class="row difficulty-row"><label for="ra-diff-${item.key}">${item.name}<small data-difficulty-range="${item.key}">100–${Math.round(item.max * 100)}%</small></label><input type="range" id="ra-diff-${item.key}" data-difficulty="${item.key}" min="1" max="${item.max}" step="0.05"><output for="ra-diff-${item.key}" data-difficulty-out="${item.key}">100%</output></div>`).join('')}
                                </div>
                                <div class="hint" id="ra-stage-hint"></div>
                            </details>
                            <details open class="skills-card"><summary>技能配置</summary>
                                <div class="job-label" id="ra-job">等待讀取目前角色職業</div>
                                <div class="hint" id="ra-talents" title="游標移入可查看已讀取的天賦">等待讀取角色天賦</div>
                                <div class="hint">天賦與裝備變更時自動同步。↑ ↓ 排序；❌ 排除並置底，暫時消失的技能保留設定。</div>
                                <div id="ra-skill-list" class="skill-list"></div>
                            </details>
                            <details open class="chest-card"><summary>本局道具與神祇</summary>
                                <div class="job-label" id="ra-chest-job">等待讀取目前角色職業</div>
                                <div class="hint">↑ ↓ 排序；❌ 排除並置底。每類限 1 種，屬性／技能神祇共用 1 欄。</div>
                                <div class="hint">依官方本局條件更新，游標可看效果範圍。先補齊：神祇 → 祝福 → 秘藥 → 藥水 → 料理。</div>
                                <div id="ra-chest-groups"></div>
                            </details>
                            <details class="wide-span"><summary>備份與紀錄</summary>
                                <div class="row"><button id="ra-export">匯出設定</button><button id="ra-import">匯入設定</button><button id="ra-reconnect">重新連接</button><input type="file" id="ra-file" accept="application/json,.json" hidden></div>
                                <div id="ra-log" class="log"></div>
                            </details>
                        </div>
                    </div>
                    <button id="ra-resize" class="resize-handle" title="拖曳調整大小；方向鍵微調" aria-label="調整面板大小（方向鍵）">↘</button>
                </section>`;
            document.body.append(this.host);
            this.ui.addEventListener('keydown', event => { if (event.key !== 'F8') event.stopPropagation(); });
            this.ui.addEventListener('pointerdown', event => event.stopPropagation());
            this.ui.querySelector('#ra-reconnect').onclick = () => this.connect();
            this.bindPanelControls();
            this.ui.querySelector('#ra-stage').onchange = event => {
                this.settings.stage = event.target.value;
                this.saveSettings();
                this.renderStageControls();
            };
            for (const input of this.ui.querySelectorAll('[data-setting]')) input.onchange = () => {
                this.settings[input.dataset.setting] = input.type === 'checkbox' ? input.checked : Number(input.value);
                this.saveSettings();
                this.refreshInputs();
            };
            for (const input of this.ui.querySelectorAll('[data-difficulty]')) input.oninput = () => {
                this.settings.difficulty[input.dataset.difficulty] = Number(input.value);
                this.saveSettings();
                this.ui.querySelector(`[data-difficulty-out="${input.dataset.difficulty}"]`).textContent = `${Math.round(Number(input.value) * 100)}%`;
            };
            this.ui.querySelector('#ra-export').onclick = () => {
                this.refreshSkillContext();
                this.saveSettings();
                const url = URL.createObjectURL(new Blob([JSON.stringify(this.exportSettings(), null, 2)], { type: 'application/json' }));
                const anchor = document.createElement('a');
                anchor.href = url; anchor.download = this.settingsExportFilename(); anchor.click();
                setTimeout(() => URL.revokeObjectURL(url), 1000);
            };
            this.ui.querySelector('#ra-import').onclick = () => this.ui.querySelector('#ra-file').click();
            this.ui.querySelector('#ra-file').onchange = async event => {
                try {
                    const file = event.target.files[0];
                    if (!file) return;
                    this.importSettings(JSON.parse(await file.text()));
                    this.skillContextSignature = '';
                    this.chestContextSignature = '';
                    this.refreshSkillContext();
                    this.refreshChestContext();
                    this.refreshInputs();
                    this.applyPanelLayout();
                    this.log('已匯入設定');
                } catch { this.log('設定檔格式錯誤'); }
                event.target.value = '';
            };
            this.refreshInputs();
        }

        refreshInputs() {
            if (!this.ui) return;
            for (const input of this.ui.querySelectorAll('[data-setting]')) {
                const value = this.settings[input.dataset.setting];
                if (input.type === 'checkbox') input.checked = value;
                else input.value = value;
            }
            for (const input of this.ui.querySelectorAll('[data-difficulty]')) {
                const item = (this.activeMode === 'party' ? PARTY_DIFFICULTY : DIFFICULTY).find(entry => entry.key === input.dataset.difficulty);
                input.max = String(item.max);
                const range = this.ui.querySelector(`[data-difficulty-range="${item.key}"]`);
                if (range) range.textContent = `100–${Math.round(item.max * 100)}%`;
                input.value = this.settings.difficulty[input.dataset.difficulty];
                this.ui.querySelector(`[data-difficulty-out="${input.dataset.difficulty}"]`).textContent = `${Math.round(Number(input.value) * 100)}%`;
            }
            this.renderSkillList();
            this.renderChestGroups();
            this.renderModeControls();
            const select = this.ui.querySelector('#ra-stage');
            select.value = this.settings.stage;
            if (select.selectedIndex < 0) select.value = 'first';
            this.renderStageControls();
        }

        renderStageControls() {
            if (!this.ui) return;
            const festival = isLanternStage(this.settings.stage);
            const controls = this.ui.querySelector('#ra-difficulty-controls');
            if (controls) controls.hidden = festival;
            for (const input of this.ui.querySelectorAll('[data-difficulty]')) input.disabled = festival;
            const hint = this.ui.querySelector('#ra-stage-hint');
            if (hint) hint.textContent = festival
                ? '燈籠節為固定難度，採即時升級；一般副本的難度設定已保留。組隊由隊長提議，隊員自動準備。'
                : '難度下一場套用；組隊由隊長提議，隊員自動準備，全員回城後接續。';
        }

        log(message) {
            if (!this.ui) return;
            const log = this.ui.querySelector('#ra-log');
            const time = new Date().toLocaleTimeString();
            log.textContent = `[${time}] ${message}\n${log.textContent}`.split('\n').slice(0, 30).join('\n');
        }

        renderStatus() {
            if (!this.ui) return;
            this.ui.querySelector('#ra-status').textContent = this.status;
            this.renderModeControls();
            const connecting = this.connectionState === 'connecting';
            const connection = this.ui.querySelector('#ra-connection');
            const phase = { idle: '等待連接', connecting: '連接中', ready: '已連接', failed: '連接失敗' }[this.connectionState];
            connection.textContent = `v${VERSION} by nyqvori1268 · ${phase || '等待連接'}${this.connectionError ? ` · ${this.connectionError}` : ''}`;
            connection.classList.toggle('failed', this.connectionState === 'failed');
            this.ui.querySelector('#ra-reconnect').disabled = connecting;
            const shortcut = this.ui.querySelector('#ra-shortcut');
            shortcut.textContent = this.enabled ? 'F8 關閉自動' : connecting ? '連接中…' : 'F8 開啟自動';
            shortcut.classList.toggle('running', this.enabled);
            const game = this.game;
            this.ui.querySelector('#ra-stat').textContent = game && !this.visible('#lobby-ui')
                ? `已完成 ${this.runCount} 場 · 技能重試 ${this.retryCount} 次 · Lv ${game.level} · HP ${Math.ceil(game.hp)} / ${Math.ceil(game.stats?.maxHp || 0)}（${Math.round(game.hp / Math.max(1, game.stats?.maxHp || 0) * 100)}%） · ${game.zeny} z`
                : `已完成 ${this.runCount} 場 · 技能重試 ${this.retryCount} 次`;
        }
    }

    // The exports allow the decision and controller logic to be tested without starting a game.
    if (typeof module === 'object' && module.exports) {
        module.exports = { DEFAULTS, AUTOMATIC_RULES, DIFFICULTY, PARTY_DIFFICULTY, LANTERN_STAGE, CHEST_SLOTS, CHEST_CATEGORY_ORDER, QUALITY_NAMES, PANEL_DEFAULTS, panelLayout, normalizeSettings, snapshotSettings, normalizeModeStore, readPartyState, partyDialogKind, isLanternStage, departureDialogKind, townNpcMatches, parseSkillRules, normalizeSkillProfile, mergeSkillProfile,
            moveSkill, readTalentSkills, talentSkillSources, readSkillTransforms, buildSkillCatalog, cardQuality, rerollIsLocked, highestQualityChoice, eliminationChoicesExhausted, exhaustedChoice, canTankDamage, canTankChest, valuablePickup, ordinaryPickup, openingFarmActive, meatHealing, routePickupContact, recoveryOpportunity, configuredSkillDecision, buildChestCatalog, chestCandidateRanks, configuredChestDecision,
            skillProfileId, preferredIds, nativeCardActions, cardControlPlans, pendingNativeOffer, pickStage, parseImports,
            findRegistryBinding, resolveGameBindings, zoneContains, threatRisk, movingArrowRisk, friendlyAreaPoint, selectFriendlyArea,
            readBellShelters, selectBellShelter, bellDestination, bellRoute, navigationContext, terrainSpace, crowdPressure,
            navigationRisk, navigationPath, findRetreatRoute, planMotion, findEscapePoint, chestBudget, segmentDistanceSquared, safeResourceRoute, resourceFarmPlan, pickupScore, AutoExpedition };
        return;
    }
    if (typeof window === 'undefined' || window.top !== window.self || location.pathname !== '/') return;
    if (document.getElementById('ro-auto-panel')) return;
    const controller = new AutoExpedition();
    controller.connect();
})();
