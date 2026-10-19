let API_URL = `https://vokabel-trainer-backend.onrender.com`; 
let currentUser = null; 
let currentLanguage = 'Latein';
let testPool = [];
let testIdx = 0;
let score = 0;
let syncInProgress = new Set();
let syncDebounceTimer = null;
let sessionGeneration = 0;

function lessonsStorageKey(username = currentUser, language = currentLanguage) {
    if (!username) return null;
    return `lessons:v2:${encodeURIComponent(username)}:${encodeURIComponent(language.toLowerCase())}`;
}

function syncPendingStorageKey(username = currentUser, language = currentLanguage) {
    if (!username) return null;
    return `sync_pending:v2:${encodeURIComponent(username)}:${encodeURIComponent(language.toLowerCase())}`;
}

function sessionTokenStorageKey(username) {
    return `session_token:v2:${encodeURIComponent(username)}`;
}

function offlineVerifierStorageKey(username) {
    return `offline_verifier:v2:${encodeURIComponent(username)}`;
}

function getSessionToken(username = currentUser) {
    return username ? localStorage.getItem(sessionTokenStorageKey(username)) : null;
}

function authenticatedHeaders(username = currentUser, extraHeaders = {}) {
    const token = getSessionToken(username);
    return token ? { ...extraHeaders, Authorization: `Bearer ${token}` } : extraHeaders;
}

function hasPendingChanges(username = currentUser, language = currentLanguage) {
    const key = syncPendingStorageKey(username, language);
    return key ? localStorage.getItem(key) === 'true' : false;
}

async function deriveOfflineVerifier(username, password) {
    const encoder = new TextEncoder();
    const keyMaterial = await crypto.subtle.importKey('raw', encoder.encode(password), 'PBKDF2', false, ['deriveBits']);
    const bits = await crypto.subtle.deriveBits({
        name: 'PBKDF2',
        salt: encoder.encode(`vokabel-trainer-offline-v2:${username}`),
        iterations: 210000,
        hash: 'SHA-256'
    }, keyMaterial, 256);
    return btoa(String.fromCharCode(...new Uint8Array(bits)));
}

// === SCHRITT 1: DER START-WÄCHTER (REIN SYNCHRON) ===
window.addEventListener('DOMContentLoaded', () => {
    const savedUser = localStorage.getItem('last_user');
    const loginStatus = localStorage.getItem('is_logged_in'); 
    currentLanguage = localStorage.getItem('last_language') || 'Latein';
    document.getElementById('lang-select').value = currentLanguage;
    document.getElementById('lang-select-mobile').value = currentLanguage;
    
    const hasOfflineVerifier = savedUser && localStorage.getItem(offlineVerifierStorageKey(savedUser));
    if (savedUser && loginStatus === 'true' && (getSessionToken(savedUser) || (!navigator.onLine && hasOfflineVerifier))) {
        currentUser = savedUser;
        sessionGeneration++;
        showApp();
        refreshFromServer({ silent: true });
    } else {
        localStorage.setItem('is_logged_in', 'false');
        const az = document.getElementById('auth-zone');
        const lz = document.getElementById('app-zone');
        if (az) az.classList.remove('d-none');
        if (lz) lz.classList.add('d-none');
    }

    // Den Button unlösbar verdrahten
    const loginBtn = document.getElementById('login-btn');
    if (loginBtn) {
        loginBtn.addEventListener('click', handleLoginAttempt);
    }

    window.addEventListener('online', () => {
        updateSyncStatus('Online – Synchronisierung wird gestartet…');
        if (currentUser) {
            if (hasPendingChanges()) {
                syncPendingChanges({ silent: true });
            } else {
                refreshFromServer({ silent: true });
            }
        }
    });

    document.addEventListener('visibilitychange', () => {
        if (document.visibilityState === 'visible' && navigator.onLine && currentUser) {
            refreshFromServer({ silent: true });
        }
    });
});

// === SCHRITT 2: DIE RADIKALE LOGIN-WEICHE (REIN SYNCHRON) ===
async function handleLoginAttempt() {
    // 1. DIAGNOSE-ALARM: Tut der Button überhaupt physisch etwas?

    const userInput = document.getElementById('username');
    const passInput = document.getElementById('password');
    
    if (!userInput || !passInput) {
        return;
    }

    const user = userInput.value.trim();
    const pass = passInput.value;


    const storedUser = localStorage.getItem('last_user');
    if (!navigator.onLine) {
        if (!storedUser || storedUser.toLowerCase() !== user.toLowerCase()) {
            alert('Offline-Anmeldung ist nur für ein zuvor auf diesem Gerät angemeldetes Konto möglich.');
            return;
        }
        try {
            const verifier = await deriveOfflineVerifier(storedUser, pass);
            if (localStorage.getItem(offlineVerifierStorageKey(storedUser)) !== verifier) {
                alert('Offline-Anmeldung fehlgeschlagen. Bitte Zugangsdaten prüfen.');
                return;
            }
            currentUser = storedUser;
            sessionGeneration++;
            localStorage.setItem('is_logged_in', 'true');
            showApp();
        } catch (error) {
            alert('Offline-Anmeldung wird von diesem Browser nicht unterstützt.');
        }
        return;
    }

    executeOnlineLogin(user, pass);
}

// === SCHRITT 3: ISOLIERTE NETZWERK-PROZESSE (KOMPLETT ABGEKAPSELT) ===

// Reiner Online-Login, falls lokal kein Match vorliegt
function executeOnlineLogin(user, pass) {
    if (!navigator.onLine) {
        alert("🚫 Login fehlgeschlagen!\nDie Daten stimmen nicht mit den gespeicherten Offline-Daten überein.");
        return;
    }

    fetch(`${API_URL}/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username: user, password: pass })
    })
    .then(res => {
        if (res.ok) {
            return res.json();
        }
        throw new Error('Falsche Zugangsdaten oder Anmeldung nicht verfügbar');
    })
    .then(async resData => {
        if (!resData.username || !resData.access_token) {
            throw new Error('Backend-Sitzungstoken fehlt');
        }
        currentUser = resData.username;
        sessionGeneration++;
        const verifier = await deriveOfflineVerifier(currentUser, pass);
        localStorage.setItem('last_user', currentUser);
        localStorage.setItem(offlineVerifierStorageKey(currentUser), verifier);
        localStorage.setItem(sessionTokenStorageKey(currentUser), resData.access_token);
        localStorage.setItem('is_logged_in', 'true'); 
        showApp();
        refreshFromServer({ silent: true });
    })
    .catch(err => {
        console.error('Login-Fehler:', err);
        alert(`Online-Anmeldung fehlgeschlagen: ${err.message}`);
    });
}

// Stiller Hintergrund-Check, falls wir im LAN sind, um Vokabeln upzudaten
function executeBackgroundNetworkCheck(user, pass) {
    if (!navigator.onLine) return;

    fetch(`${API_URL}/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username: user, password: pass })
    })
    .then(res => {
        if (res.ok) {
            downloadFromServer();
        }
    })
    .catch(e => console.log("Hintergrund-Check: Mac Mini nicht im selben Netz (Bus-Modus)."));
}

function login() {
    handleLoginAttempt();
}

// === SCHRITT 4: APP-LOGIK UND ENGINE ===
function showApp() {
    if (!currentUser) return;
    const az = document.getElementById('auth-zone');
    const lz = document.getElementById('app-zone');
    if (az) az.classList.add('d-none');
    if (lz) lz.classList.remove('d-none');
    
    const userDisplay = document.getElementById('user-display');
    if (userDisplay) userDisplay.innerText = currentUser;
    
    updateSyncStatus('Synchronisation bereit');
    buildInterface();
}

function logout() {
    sessionGeneration++;
    if (syncDebounceTimer) {
        window.clearTimeout(syncDebounceTimer);
        syncDebounceTimer = null;
    }
    if (currentUser) {
        localStorage.removeItem(sessionTokenStorageKey(currentUser));
    }
    localStorage.setItem('is_logged_in', 'false');
    currentUser = null;
    testPool = [];
    testIdx = 0;
    score = 0;
    const az = document.getElementById('auth-zone');
    const lz = document.getElementById('app-zone');
    if (az) az.classList.remove('d-none');
    if (lz) lz.classList.add('d-none');
    document.getElementById('password').value = '';
    document.getElementById('username').value = '';
    document.getElementById('user-display').innerText = '—';
    document.getElementById('active-test-zone').classList.add('d-none');
    document.getElementById('setup-test-zone').classList.remove('d-none');
}

function updateSyncStatus(message, isError = false) {
    const statusEl = document.getElementById('sync-status');
    if (!statusEl) return;
    statusEl.innerText = message;
    statusEl.className = `small mt-2 ${isError ? 'text-danger' : 'text-muted'}`;
}

function mergeLessonsData(localLessons, remoteLessons) {
    const result = JSON.parse(JSON.stringify(localLessons || {}));

    Object.entries(remoteLessons || {}).forEach(([lessonName, remoteVocabs]) => {
        if (!Array.isArray(remoteVocabs)) return;
        if (!result[lessonName]) result[lessonName] = [];

        const localVocabs = Array.isArray(result[lessonName]) ? result[lessonName] : [];
        const localByWord = new Map(localVocabs.map(v => [v.wort, v]));

        remoteVocabs.forEach((remoteVocab) => {
            if (!remoteVocab || !remoteVocab.wort) return;
            const localVocab = localByWord.get(remoteVocab.wort);
            const localTs = localVocab?.updated_at ? new Date(localVocab.updated_at).getTime() : 0;
            const remoteTs = remoteVocab.updated_at ? new Date(remoteVocab.updated_at).getTime() : 0;

            if (!localVocab) {
                localVocabs.push(remoteVocab);
                localByWord.set(remoteVocab.wort, remoteVocab);
            } else if (remoteTs > localTs) {
                Object.assign(localVocab, remoteVocab);
            }
        });

        result[lessonName] = localVocabs;
    });

    return result;
}

function scheduleSync() {
    const pendingKey = syncPendingStorageKey();
    if (!pendingKey) return;
    localStorage.setItem(pendingKey, 'true');

    if (!navigator.onLine || !currentUser) return;

    if (syncDebounceTimer) {
        window.clearTimeout(syncDebounceTimer);
    }

    syncDebounceTimer = window.setTimeout(() => {
        syncPendingChanges({ silent: true });
    }, 400);
}

async function refreshFromServer(options = {}) {
    const { silent = true } = options;
    if (!navigator.onLine || !currentUser) return;
    const username = currentUser;
    const language = currentLanguage;
    const generation = sessionGeneration;
    if (!getSessionToken(username)) {
        if (!silent) updateSyncStatus('Bitte online erneut anmelden, um die Sitzung zu erneuern.', true);
        return;
    }

    try {
        const response = await fetch(`${API_URL}/api/vocab/${encodeURIComponent(username)}/${encodeURIComponent(language)}`, {
            headers: authenticatedHeaders(username)
        });
        if (!response.ok) {
            if (response.status === 401) {
                logout();
                return;
            }
            throw new Error(`HTTP ${response.status}`);
        }
        const remoteLessons = await response.json();
        if (generation !== sessionGeneration || username !== currentUser || language !== currentLanguage) return;

        const localKey = lessonsStorageKey(username, language);
        const localData = JSON.parse(localStorage.getItem(localKey) || '{}');
        const lessons = hasPendingChanges(username, language)
            ? mergeLessonsData(localData, remoteLessons)
            : remoteLessons;
        localStorage.setItem(localKey, JSON.stringify(lessons));
        if (!silent) {
            updateSyncStatus('Daten vom Server geladen');
        }
        buildInterface();
    } catch (error) {
        if (generation !== sessionGeneration || username !== currentUser) return;
        if (!silent) {
            updateSyncStatus(`Serverdaten konnten nicht geladen werden: ${error.message}`, true);
        }
        buildInterface();
    }
}

function downloadFromServer() {
    refreshFromServer({ silent: true });
}

function syncPendingChanges(options = {}) {
    const { silent = true, showAlert = false } = options;
    if (!navigator.onLine || !currentUser) return;

    const username = currentUser;
    const language = currentLanguage;
    const generation = sessionGeneration;
    const syncKey = `${username}:${language.toLowerCase()}`;
    if (syncInProgress.has(syncKey) || (!options.force && !hasPendingChanges(username, language))) return;
    if (!getSessionToken(username)) {
        updateSyncStatus('Bitte online erneut anmelden, um die Sitzung zu erneuern.', true);
        return;
    }
    const storageKey = lessonsStorageKey(username, language);
    const data = JSON.parse(localStorage.getItem(storageKey) || '{}');
    syncInProgress.add(syncKey);
    if (!silent) {
        updateSyncStatus('Synchronisiere…');
    }

    fetch(`${API_URL}/api/sync/${encodeURIComponent(username)}/${encodeURIComponent(language)}`, {
        method: 'POST',
        headers: authenticatedHeaders(username, { 'Content-Type': 'application/json' }),
        body: JSON.stringify({ lessons: data })
    })
    .then(async res => {
        const text = await res.text();
        let json;
        try {
            json = text ? JSON.parse(text) : {};
        } catch (err) {
            throw new Error(`Invalid JSON response: ${text}`);
        }
        if (!res.ok) {
            if (res.status === 401) {
                localStorage.removeItem(sessionTokenStorageKey(username));
                logout();
            }
            throw new Error(json.detail || json.message || `HTTP ${res.status}`);
        }
        return json;
    })
    .then(resData => {
        if (resData.status === 'synced') {
            if (generation !== sessionGeneration || username !== currentUser) return;
            localStorage.setItem(syncPendingStorageKey(username, language), 'false');
            localStorage.setItem(`last_sync:v2:${encodeURIComponent(username)}:${encodeURIComponent(language.toLowerCase())}`, new Date().toISOString());
            const lastSync = new Date().toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit' });
            updateSyncStatus(`Zuletzt synchronisiert: ${lastSync}`);
            if (showAlert) {
                alert('Erfolgreich mit dem Server synchronisiert. 🚀');
            }
            refreshFromServer({ silent: true });
        } else {
            throw new Error('Sync fehlgeschlagen');
        }
    })
    .catch(e => {
        console.error('Sync-Fehler:', e);
        if (generation !== sessionGeneration || username !== currentUser) return;
        localStorage.setItem(syncPendingStorageKey(username, language), 'true');
        updateSyncStatus(`Synchronisierung fehlgeschlagen: ${e.message}`, true);
        if (showAlert) {
            alert(`Synchronisierung konnte gerade nicht abgeschlossen werden:\n${e.message}`);
        }
    })
    .finally(() => {
        syncInProgress.delete(syncKey);
    });
}

function changeLanguage() {
    const desktopSelect = document.getElementById('lang-select');
    currentLanguage = desktopSelect ? desktopSelect.value : 'Latein';
    localStorage.setItem('last_language', currentLanguage);
    document.getElementById('lang-select-mobile').value = currentLanguage;
    buildInterface();
    downloadFromServer();
}

function switchPage(pageId) {
    document.querySelectorAll('.page-content').forEach(p => p.classList.add('d-none'));
    document.querySelectorAll('.nav-link').forEach(l => l.classList.remove('active'));
    
    document.querySelectorAll('.nav-link-' + pageId).forEach(l => l.classList.add('active'));
    const targetPage = document.getElementById('page-' + pageId);
    if (targetPage) targetPage.classList.remove('d-none');
    buildInterface();
}

function buildInterface() {
    const checkboxZone = document.getElementById('lessons-checkboxes');
    if (!currentUser) {
        if (checkboxZone) checkboxZone.innerHTML = '';
        return;
    }
    const data = JSON.parse(localStorage.getItem(lessonsStorageKey()) || '{}');
    if (!checkboxZone) return;
    
    checkboxZone.innerHTML = '';
    checkboxZone.innerHTML += `<div class="form-check"><input class="form-check-input spec-filter" type="checkbox" value="nochmal" id="f-nochmal"><label class="form-check-label fw-bold" for="f-nochmal">🔄 nochmal üben / offen</label></div>`;
    checkboxZone.innerHTML += `<div class="form-check mb-3"><input class="form-check-input spec-filter" type="checkbox" value="gut" id="f-gut"><label class="form-check-label fw-bold" for="f-gut">✅ sehr gut</label></div>`;

    for (let lesson in data) {
        checkboxZone.innerHTML += `<div class="form-check"><input class="form-check-input lesson-check" type="checkbox" value="${lesson}" id="l-${lesson}"><label class="form-check-label" for="l-${lesson}">📖 ${lesson}</label></div>`;
    }

    calculateStatistics(data);
    renderLibrary(data);
}

function startTest() {
    const data = JSON.parse(localStorage.getItem(lessonsStorageKey()) || '{}');
    let combined = [];
    
    const filterNochmal = document.getElementById('f-nochmal').checked;
    const filterGut = document.getElementById('f-gut').checked;
    
    let activeLessons = Array.from(document.querySelectorAll('.lesson-check:checked')).map(c => c.value);

    if(activeLessons.length === 0 && (filterNochmal || filterGut)) {
        activeLessons = Object.keys(data);
    }

    activeLessons.forEach(l => {
        if(data[l]) {
            data[l].forEach(v => {
                v.origin_file = l;
                let status = v.status || 'gar nicht';
                if(filterNochmal && (status === 'gar nicht' || status === 'nochmal üben')) combined.push(v);
                else if(filterGut && status === 'sehr gut') combined.push(v);
                else if(!filterNochmal && !filterGut) combined.push(v);
            });
        }
    });

    testPool = Array.from(new Map(combined.map(item => [item.wort, item])).values());
    if(testPool.length === 0) return alert("Keine Vokabeln für diese Auswahl gefunden!");

    testPool.sort(() => Math.random() - 0.5);
    const count = Math.min(parseInt(document.getElementById('test-count').value) || 10, testPool.length);
    testPool = testPool.slice(0, count);

    testIdx = 0;
    score = 0;

    document.getElementById('setup-test-zone').classList.add('d-none');
    document.getElementById('active-test-zone').classList.remove('d-none');
    showQuestion();
}

function showQuestion() {
    const currentItem = testPool[testIdx];
    document.getElementById('test-progress').innerText = `Frage ${testIdx + 1} von ${testPool.length}`;
    document.getElementById('question-word').innerText = currentItem.wort;
    document.getElementById('user-answer').value = '';
    document.getElementById('user-answer').disabled = false;
    document.getElementById('result-box').classList.add('d-none');
    document.getElementById('next-btn').classList.add('d-none');
    document.getElementById('check-btn').classList.remove('d-none');

    const genusZone = document.getElementById('genus-zone');
    if(currentLanguage === 'Latein' && currentItem.genus && ['m','f','n'].includes(currentItem.genus)) {
        genusZone.classList.remove('d-none');
        document.querySelectorAll('input[name="genus-opt"]').forEach(r => r.checked = false);
    } else {
        genusZone.classList.add('d-none');
    }
}

function checkAnswer() {
    const currentItem = testPool[testIdx];
    const input = document.getElementById('user-answer').value.toLowerCase().trim();
    
    let hasGenus = currentLanguage === 'Latein' && currentItem.genus && ['m','f','n'].includes(currentItem.genus);
    let genusRadio = document.querySelector('input[name="genus-opt"]:checked');
    
    if(!input) return alert("Bitte eine Übersetzung eingeben!");
    if(hasGenus && !genusRadio) return alert("Bitte das Genus wählen!");

    let cleanTranslation = currentItem.uebersetzung.toLowerCase().replace(/;/g, ',').replace(/\(|\)/g, ' ');
    let stopWords = ["der", "die", "das", "ein", "eine", "ist", "zu"];
    
    let validWords = cleanTranslation.split(/[,\s]+/).map(w => w.trim()).filter(w => w && !stopWords.includes(w));
    let userWords = input.split(/\s+/);

    let isExactWord = userWords.some(w => validWords.includes(w));
    let isPartOfPhrase = cleanTranslation.includes(input) && input.length > 2;
    
    let isTransOk = isExactWord || isPartOfPhrase;
    let isGenusOk = hasGenus ? (genusRadio.value === currentItem.genus) : true;
    let isCorrect = isTransOk && isGenusOk;

    const resBox = document.getElementById('result-box');
    resBox.classList.remove('d-none', 'alert-success', 'alert-danger');
    
    let displayGenus = currentItem.genus ? ` (${currentItem.genus})` : '';
    if (isCorrect) {
        resBox.innerText = `Richtig! 🎉 Korrekt: ${currentItem.uebersetzung}${displayGenus}`;
        resBox.classList.add('alert-success');
        currentItem.richtig = (currentItem.richtig || 0) + 1;
        currentItem.status = "sehr gut";
        score++;
    } else {
        resBox.innerText = `Falsch! Korrekt wäre: ${currentItem.uebersetzung}${displayGenus}`;
        resBox.classList.add('alert-danger');
        currentItem.falsch = (currentItem.falsch || 0) + 1;
        currentItem.status = "nochmal üben";
    }

    saveProgressToLocalStorage(currentItem);

    document.getElementById('user-answer').disabled = true;
    document.getElementById('check-btn').classList.add('d-none');
    document.getElementById('next-btn').classList.remove('d-none');
}

function nextQuestion() {
    testIdx++;
    if(testIdx < testPool.length) {
        showQuestion();
    } else {
        alert(`Test beendet! Dein Score: ${score} von ${testPool.length}`);
        document.getElementById('setup-test-zone').classList.remove('d-none');
        document.getElementById('active-test-zone').classList.add('d-none');
        buildInterface();
        if (navigator.onLine) { syncPendingChanges({ silent: true }); }
    }
}

function saveProgressToLocalStorage(item) {
    const storageKey = lessonsStorageKey();
    if (!storageKey) return;
    let data = JSON.parse(localStorage.getItem(storageKey) || '{}');
    let lesson = data[item.origin_file];
    if(lesson) {
        let idx = lesson.findIndex(v => v.wort === item.wort);
        if(idx !== -1) {
            const now = new Date().toISOString();
            lesson[idx] = {
                ...lesson[idx],
                ...item,
                updated_at: now,
                created_at: lesson[idx].created_at || item.created_at || now
            };
        }
    }
    localStorage.setItem(storageKey, JSON.stringify(data));
    scheduleSync();
}

function calculateStatistics(data) {
    let total = 0, mastered = 0;
    let allVocabs = [];

    for (let l in data) {
        data[l].forEach(v => {
            total++;
            if(v.status === 'sehr gut') mastered++;
            let r = v.richtig || 0;
            let f = v.falsch || 0;
            let totalTries = r + f;
            v.quote = totalTries > 0 ? (f / totalTries) : 0;
            v.totalTries = totalTries;
            v.lektion = l;
            allVocabs.push(v);
        });
    }

    let remaining = total - mastered;
    let ratio = total > 0 ? (mastered / total) : 0;

    const statTotal = document.getElementById('stat-total');
    if(statTotal) statTotal.innerText = `${total} Wörter`;
    if(document.getElementById('stat-mastered')) document.getElementById('stat-mastered').innerText = mastered;
    if(document.getElementById('stat-remaining')) document.getElementById('stat-remaining').innerText = remaining;
    
    const bar = document.getElementById('stat-progress-bar');
    if(bar) {
        bar.style.width = `${ratio*100}%`;
        bar.innerText = `${(ratio*100).toFixed(1)}%`;
    }

    const wreath = document.getElementById('wreath-output');
    if(wreath) {
        let numGold = Math.floor((ratio * 100) / 4);
        let goldLeaves = "🌿".repeat(numGold);
        let greyLeaves = "🌿".repeat(25 - numGold);
        wreath.innerHTML = `
            <div class="wreath-container">
                <div class="fw-bold mb-1 text-secondary">Corona Victoriae (${(ratio*100).toFixed(1)}%)</div>
                <span class="leaf-gold">${goldLeaves}</span><span class="leaf-grey">${greyLeaves}</span>
            </div>`;
    }

    let angstPool = allVocabs.filter(v => v.totalTries >= 2 && v.quote > 0.3).sort((a,b) => b.quote - a.quote).slice(0, 5);
    let heldenPool = allVocabs.filter(v => v.totalTries >= 2).sort((a,b) => a.quote - b.quote || b.richtig - a.richtig).slice(0, 5);

    const angstZone = document.getElementById('angstgegner-list');
    if(angstZone) {
        angstZone.innerHTML = angstPool.length ? '' : '<div class="text-muted">Keine Angstgegner identifiziert.</div>';
        angstPool.forEach(v => { angstZone.innerHTML += `<div class="list-group-item list-group-item-danger d-flex justify-content-between"><strong>${v.wort}</strong> <span>${(v.quote*100).toFixed(0)}% Fehler (${v.falsch}❌)</span></div>`; });
    }

    const heldenZone = document.getElementById('helden-list');
    if(heldenZone) {
        heldenZone.innerHTML = heldenPool.length ? '' : '<div class="text-muted">Lerne weiter, um deine Helden zu küren!</div>';
        heldenPool.forEach(v => { heldenZone.innerHTML += `<div class="list-group-item list-group-item-success d-flex justify-content-between"><strong>${v.wort}</strong> <span>${((1-v.quote)*100).toFixed(0)}% Erfolg (${v.richtig}✅)</span></div>`; });
    }
}

function renderLibrary(data) {
    const container = document.getElementById('library-container');
    if(!container) return;
    container.innerHTML = '';

    for (let lesson in data) {
        let html = `
            <div class="card mb-3 shadow-sm">
                <div class="card-header bg-dark text-white fw-bold">📖 Lektion: ${lesson}</div>
                <div class="card-body p-2">
                    <table class="table table-sm table-striped">
                        <thead><tr><th>Wort</th><th>Übersetzung</th><th>Genus</th><th>Status</th></tr></thead>
                        <tbody>`;
        
        data[lesson].forEach((v) => {
            html += `<tr>
                <td><strong>${v.wort}</strong></td>
                <td>${v.uebersetzung}</td>
                <td><span class="badge bg-secondary">${v.genus || '—'}</span></td>
                <td><span class="badge ${v.status==='sehr gut'?'bg-success':'bg-warning'}">${v.status || 'gar nicht'}</span></td>
            </tr>`;
        });
        html += `</tbody></table></div></div>`;
        container.innerHTML += html;
    }
}

function createNewLessonOnly() {
    const name = document.getElementById('new-lesson-name').value.trim();
    if(!name) return alert("Bitte Namen eingeben!");
    const storageKey = lessonsStorageKey();
    if (!storageKey) return;
    let data = JSON.parse(localStorage.getItem(storageKey) || '{}');
    if(data[name]) return alert("Lektion existiert bereits!");
    data[name] = [];
    localStorage.setItem(storageKey, JSON.stringify(data));
    scheduleSync();
    document.getElementById('new-lesson-name').value = '';
    alert(`Lektion '${name}' erfolgreich lokal angelegt!`);
    buildInterface();
}

function triggerSync() {
    if (!navigator.onLine) {
        updateSyncStatus('Du bist gerade offline. Die Änderungen bleiben lokal und werden später synchronisiert.', true);
        return;
    }
    syncPendingChanges({ silent: false, showAlert: true, force: true });
}

function triggerSyncSilently() {
    syncPendingChanges({ silent: true });
}