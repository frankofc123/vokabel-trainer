let API_URL = `https://vokabel-trainer-backend.onrender.com`; 
let currentUser = null; 
let currentLanguage = 'Latein';
let testPool = [];
let testIdx = 0;
let score = 0;
let syncInProgress = false;
let syncDebounceTimer = null;

// === SCHRITT 1: DER START-WÄCHTER (REIN SYNCHRON) ===
window.addEventListener('DOMContentLoaded', () => {
    const savedUser = localStorage.getItem('last_user');
    const savedHash = localStorage.getItem('offline_auth_hash');
    const loginStatus = localStorage.getItem('is_logged_in'); 
    
    if (savedUser && savedHash && loginStatus === 'true') {
        currentUser = savedUser;
        showApp();
        refreshFromServer({ silent: true });
    } else {
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
            syncPendingChanges({ silent: true });
        }
    });

    document.addEventListener('visibilitychange', () => {
        if (document.visibilityState === 'visible' && navigator.onLine && currentUser) {
            refreshFromServer({ silent: true });
        }
    });
});

// === SCHRITT 2: DIE RADIKALE LOGIN-WEICHE (REIN SYNCHRON) ===
function handleLoginAttempt() {
    // 1. DIAGNOSE-ALARM: Tut der Button überhaupt physisch etwas?

    const userInput = document.getElementById('username');
    const passInput = document.getElementById('password');
    
    if (!userInput || !passInput) {
        return;
    }

    const user = userInput.value.trim();
    const pass = passInput.value;


    const currentHash = btoa(user.toLowerCase() + ":" + pass);
    const storedUser = localStorage.getItem('last_user');
    const storedHash = localStorage.getItem('offline_auth_hash');


    if (storedUser && storedUser.toLowerCase() === user.toLowerCase() && storedHash === currentHash) {
        currentUser = storedUser;
        localStorage.setItem('is_logged_in', 'true'); 
        showApp();
        return;
    }

    executeOnlineLogin(user, pass, currentHash);
}

// === SCHRITT 3: ISOLIERTE NETZWERK-PROZESSE (KOMPLETT ABGEKAPSELT) ===

// Reiner Online-Login, falls lokal kein Match vorliegt
function executeOnlineLogin(user, pass, currentHash) {
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
        throw new Error("Falsche Zugangsdaten");
    })
    .then(resData => {
        currentUser = resData.username || user;
        localStorage.setItem('last_user', currentUser);
        localStorage.setItem('offline_auth_hash', currentHash); 
        localStorage.setItem('is_logged_in', 'true'); 
        showApp();
        refreshFromServer({ silent: true });
    })
    .catch(err => {
        alert("❌ Online-Login fehlgeschlagen. Mac Mini erreichbar?");
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
    localStorage.setItem('is_logged_in', 'false');
    const az = document.getElementById('auth-zone');
    const lz = document.getElementById('app-zone');
    if (az) az.classList.remove('d-none');
    if (lz) lz.classList.add('d-none');
    document.getElementById('password').value = "";
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
    const pendingKey = 'sync_pending_' + currentLanguage;
    localStorage.setItem(pendingKey, 'true');

    if (!navigator.onLine || !currentUser) return;

    if (syncDebounceTimer) {
        window.clearTimeout(syncDebounceTimer);
    }

    syncDebounceTimer = window.setTimeout(() => {
        syncPendingChanges({ silent: true });
    }, 400);
}

function refreshFromServer(options = {}) {
    const { silent = true } = options;
    if (!navigator.onLine || !currentUser) return;

    fetch(`${API_URL}/api/vocab/${currentUser}/${currentLanguage}`)
    .then(res => {
        if (res.ok) return res.json();
        throw new Error();
    })
    .then(lessons => {
        const localData = JSON.parse(localStorage.getItem('lessons_' + currentLanguage) || '{}');
        const mergedData = mergeLessonsData(localData, lessons);
        localStorage.setItem('lessons_' + currentLanguage, JSON.stringify(mergedData));
        if (!silent) {
            updateSyncStatus('Daten vom Server geladen');
        }
        buildInterface();
    })
    .catch(e => {
        if (!silent) {
            updateSyncStatus('Serverdaten konnten nicht geladen werden', true);
        }
        buildInterface();
    });
}

function downloadFromServer() {
    refreshFromServer({ silent: true });
}

function syncPendingChanges(options = {}) {
    const { silent = true, showAlert = false } = options;
    if (!navigator.onLine || !currentUser || syncInProgress) return;

    const data = JSON.parse(localStorage.getItem('lessons_' + currentLanguage) || '{}');
    syncInProgress = true;
    if (!silent) {
        updateSyncStatus('Synchronisiere…');
    }

    fetch(`${API_URL}/api/sync/${currentUser}/${currentLanguage}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ lessons: data })
    })
    .then(res => res.json())
    .then(resData => {
        if (resData.status === 'synced') {
            localStorage.setItem('sync_pending_' + currentLanguage, 'false');
            localStorage.setItem('last_sync_' + currentLanguage, new Date().toISOString());
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
        localStorage.setItem('sync_pending_' + currentLanguage, 'true');
        updateSyncStatus('Synchronisierung wartet, bis das Gerät wieder online ist…', true);
        if (showAlert) {
            alert('Synchronisierung konnte gerade nicht abgeschlossen werden. Die Daten bleiben lokal gespeichert.');
        }
    })
    .finally(() => {
        syncInProgress = false;
    });
}

function changeLanguage() {
    const desktopSelect = document.getElementById('lang-select');
    currentLanguage = desktopSelect ? desktopSelect.value : 'Latein';
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
    const data = JSON.parse(localStorage.getItem('lessons_' + currentLanguage) || '{}');
    const checkboxZone = document.getElementById('lessons-checkboxes');
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
    const data = JSON.parse(localStorage.getItem('lessons_' + currentLanguage) || '{}');
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
    let data = JSON.parse(localStorage.getItem('lessons_' + currentLanguage) || '{}');
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
    localStorage.setItem('lessons_' + currentLanguage, JSON.stringify(data));
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
    let data = JSON.parse(localStorage.getItem('lessons_' + currentLanguage) || '{}');
    if(data[name]) return alert("Lektion existiert bereits!");
    data[name] = [];
    localStorage.setItem('lessons_' + currentLanguage, JSON.stringify(data));
    document.getElementById('new-lesson-name').value = '';
    alert(`Lektion '${name}' erfolgreich lokal angelegt!`);
    buildInterface();
}

function triggerSync() {
    if (!navigator.onLine) {
        updateSyncStatus('Du bist gerade offline. Die Änderungen bleiben lokal und werden später synchronisiert.', true);
        return;
    }
    syncPendingChanges({ silent: false, showAlert: true });
}

function triggerSyncSilently() {
    syncPendingChanges({ silent: true });
}