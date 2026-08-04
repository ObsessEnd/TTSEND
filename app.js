// Novel TTS Reader - Application Logic

// ==========================================
// 1. KHỞI TẠO BIẾN TOÀN CỤC & HẰNG SỐ
// ==========================================
let currentNovel = null;
let currentChapterIndex = 0;
let currentParagraphIndex = -1;
let isPlaying = false;
let voices = [];
let db = null;
let activeUtterance = null;
let consecutiveErrors = 0;
let onlineAudioPlayer = null;
let onlineChunks = [];
let currentChunkIndex = 0;

// Cấu hình mặc định
const config = {
    theme: 'sepia',
    fontSize: 18,
    lineHeight: 1.6,
    rate: 1.0,
    pitch: 1.0,
    voiceName: '',
    autoNextChapter: true,
    currentNovelTitle: 'default',
    disableWebTTS: false
};

// Khởi tạo Lucide Icons
lucide.createIcons();

// ==========================================
// 2. KHỞI TẠO INDEXEDDB (Để lưu truyện tự tải lên)
// ==========================================
function initDB() {
    return new Promise((resolve) => {
        if (!window.indexedDB) {
            console.warn("Trình duyệt không hỗ trợ IndexedDB.");
            resolve(null);
            return;
        }
        try {
            const request = indexedDB.open("NovelReaderDB", 1);
            request.onupgradeneeded = (e) => {
                const db = e.target.result;
                if (!db.objectStoreNames.contains("novels")) {
                    db.createObjectStore("novels", { keyPath: "title" });
                }
            };
            request.onsuccess = (e) => {
                db = e.target.result;
                resolve(db);
            };
            request.onerror = (e) => {
                console.error("Lỗi khởi tạo IndexedDB:", e.target.error);
                resolve(null); // Tránh văng lỗi (crash) toàn app
            };
        } catch (e) {
            console.error("Ngoại lệ khi mở IndexedDB (có thể do chế độ Ẩn danh):", e);
            resolve(null);
        }
    });
}

function saveNovelToDB(novel) {
    return new Promise((resolve, reject) => {
        if (!db) return reject("Database chưa khởi tạo");
        const transaction = db.transaction(["novels"], "readwrite");
        const store = transaction.objectStore("novels");
        const request = store.put(novel);
        request.onsuccess = () => resolve();
        request.onerror = (e) => reject(e.target.error);
    });
}

function getNovelFromDB(title) {
    return new Promise((resolve, reject) => {
        if (!db) return reject("Database chưa khởi tạo");
        const transaction = db.transaction(["novels"], "readonly");
        const store = transaction.objectStore("novels");
        const request = store.get(title);
        request.onsuccess = (e) => resolve(e.target.result);
        request.onerror = (e) => reject(e.target.error);
    });
}

// ==========================================
// 3. QUẢN LÝ TIẾN TRÌNH & CẤU HÌNH (LocalStorage)
// ==========================================
function loadConfig() {
    const savedConfig = localStorage.getItem('novel_reader_config');
    if (savedConfig) {
        try {
            Object.assign(config, JSON.parse(savedConfig));
        } catch (e) {
            console.error("Lỗi đọc cấu hình:", e);
        }
    }
    applyDisplayConfig();
}

function saveConfig() {
    try {
        localStorage.setItem('novel_reader_config', JSON.stringify(config));
    } catch (e) {
        console.warn("Không thể lưu cấu hình (có thể do WebView chặn):", e);
    }
}

function applyDisplayConfig() {
    // Áp dụng Theme
    document.body.className = '';
    document.body.classList.add(`theme-${config.theme}`);
    
    // Đồng bộ UI Theme selector
    document.querySelectorAll('.theme-option').forEach(btn => {
        if (btn.dataset.theme === config.theme) {
            btn.classList.add('active');
        } else {
            btn.classList.remove('active');
        }
    });

    // Áp dụng Cỡ chữ
    const container = document.getElementById('paragraphs-container');
    if (container) {
        container.style.fontSize = `${config.fontSize}px`;
    }
    document.getElementById('font-size-slider').value = config.fontSize;
    document.getElementById('font-size-value').textContent = `${config.fontSize}px`;

    const disableWebTTSCheckbox = document.getElementById('disable-web-tts');
    if (disableWebTTSCheckbox) {
        disableWebTTSCheckbox.checked = config.disableWebTTS || false;
    }

    // Áp dụng Giãn dòng
    if (container) {
        container.style.lineHeight = config.lineHeight;
    }
    document.getElementById('line-height-slider').value = config.lineHeight;
    document.getElementById('line-height-value').textContent = config.lineHeight;

    // Đồng bộ Rate & Pitch slider
    document.getElementById('rate-slider').value = config.rate;
    document.getElementById('rate-value').textContent = `${config.rate.toFixed(1)}x`;
    document.getElementById('pitch-slider').value = config.pitch;
    document.getElementById('pitch-value').textContent = config.pitch.toFixed(1);
    document.getElementById('auto-next-chapter').checked = config.autoNextChapter;
}

// Lưu tiến độ đọc của truyện hiện tại
function saveReadingProgress() {
    if (!currentNovel) return;
    const progress = {
        chapterIndex: currentChapterIndex,
        paragraphIndex: currentParagraphIndex,
        scrollTop: document.getElementById('reader-container').scrollTop
    };
    localStorage.setItem(`progress_${currentNovel.title}`, JSON.stringify(progress));
}

// Khôi phục tiến độ đọc
function restoreReadingProgress() {
    if (!currentNovel) return;
    const savedProgress = localStorage.getItem(`progress_${currentNovel.title}`);
    if (savedProgress) {
        try {
            const progress = JSON.parse(savedProgress);
            currentChapterIndex = progress.chapterIndex || 0;
            currentParagraphIndex = progress.paragraphIndex !== undefined ? progress.paragraphIndex : -1;
            
            // Tải chương hiện tại
            loadChapter(currentChapterIndex, false);
            
            // Cuộn trang & tô màu vàng đoạn đang đọc
            setTimeout(() => {
                if (currentParagraphIndex >= 0) {
                    highlightParagraph(currentParagraphIndex);
                    scrollParagraphIntoView(currentParagraphIndex, 'auto');
                } else if (progress.scrollTop) {
                    document.getElementById('reader-container').scrollTop = progress.scrollTop;
                }
            }, 100);
        } catch (e) {
            console.error("Lỗi khôi phục tiến trình:", e);
            loadChapter(0);
        }
    } else {
        loadChapter(0);
    }
}

// ==========================================
// 4. PHÂN TÍCH & NẠP TRUYỆN
// ==========================================
function loadChapter(index, autoPlay = false) {
    if (!currentNovel || !currentNovel.chapters || currentNovel.chapters.length === 0) return;
    
    // Đảm bảo chỉ số chương hợp lệ
    if (index < 0) index = 0;
    if (index >= currentNovel.chapters.length) index = currentNovel.chapters.length - 1;
    
    currentChapterIndex = index;
    const chapter = currentNovel.chapters[index];
    
    // Cập nhật tiêu đề chương
    document.getElementById('chapter-title').textContent = chapter.title;
    
    // Hiển thị danh sách các đoạn văn
    const container = document.getElementById('paragraphs-container');
    container.innerHTML = '';
    
    if (chapter.paragraphs.length === 0) {
        container.innerHTML = '<p class="paragraph">Chương này không có nội dung.</p>';
    } else {
        chapter.paragraphs.forEach((text, i) => {
            const p = document.createElement('div');
            p.className = 'paragraph';
            p.dataset.index = i;
            p.textContent = text;
            
            // Lắng nghe sự kiện click/chạm để đọc từ đoạn văn này
            p.addEventListener('click', () => {
                if (config.disableWebTTS) return;
                isPlaying = true;
                speakParagraph(i);
            });
            
            container.appendChild(p);
        });
        
        // Hỗ trợ Audify tự động đọc và nhảy chương
        const paginationDiv = document.createElement('div');
        paginationDiv.className = 'chapter-pagination';
        
        const prevBtn = document.createElement('button');
        prevBtn.textContent = '« Chương trước';
        prevBtn.onclick = () => {
            loadChapter(index - 1);
            document.getElementById('reader-container').scrollTop = 0;
        };
        if (index === 0) prevBtn.disabled = true;

        const nextBtn = document.createElement('button');
        nextBtn.textContent = 'Chương tiếp »';
        nextBtn.onclick = () => {
            loadChapter(index + 1);
            document.getElementById('reader-container').scrollTop = 0;
        };
        if (index === currentNovel.chapters.length - 1) nextBtn.disabled = true;

        paginationDiv.appendChild(prevBtn);
        paginationDiv.appendChild(nextBtn);
        container.appendChild(paginationDiv);
    }

    // Đồng bộ danh sách chương trong Sidebar
    document.querySelectorAll('.chapter-item').forEach((item, i) => {
        if (i === index) {
            item.classList.add('active');
            item.scrollIntoView({ block: 'nearest' });
        } else {
            item.classList.remove('active');
        }
    });

    // Reset chỉ số đoạn văn khi đổi chương (nếu không phải khôi phục tiến độ)
    if (autoPlay) {
        speakParagraph(0);
    } else if (currentParagraphIndex >= chapter.paragraphs.length) {
        currentParagraphIndex = -1;
    }
    
    saveReadingProgress();
}

function renderChapterList() {
    const listContainer = document.getElementById('chapter-list');
    listContainer.innerHTML = '';
    
    if (!currentNovel || !currentNovel.chapters) return;
    
    currentNovel.chapters.forEach((chapter, i) => {
        const li = document.createElement('li');
        li.className = 'chapter-item';
        if (i === currentChapterIndex) li.classList.add('active');
        li.textContent = chapter.title;
        li.title = chapter.title;
        li.addEventListener('click', () => {
            // Đóng sidebar trên mobile sau khi chọn chương
            document.getElementById('sidebar').classList.remove('open');
            document.getElementById('sidebar-overlay').classList.remove('open');
            stopSpeech();
            currentParagraphIndex = -1;
            loadChapter(i, false);
            document.getElementById('reader-container').scrollTop = 0;
        });
        listContainer.appendChild(li);
    });
}

function loadNovel(novel) {
    currentNovel = novel;
    document.getElementById('novel-title').textContent = novel.title;
    config.currentNovelTitle = novel.title;
    saveConfig();
    
    renderChapterList();
    restoreReadingProgress();
}

// Phân tích file văn bản TXT tự tải lên
function parseTxtFile(text, filename) {
    const lines = text.split(/\r?\n/);
    const chapters = [];
    let currentChapter = {
        title: "Giới thiệu / Mở đầu",
        paragraphs: []
    };

    // Regex thông minh nhận diện tiêu đề chương
    const chapterRegex = /^\s*(Thứ\s+\d+\s+chương|Chương\s+\d+|Chapter\s+\d+|Quyển\s+\d+|\d+\s*[\.\-:]\s*Chương)/i;

    for (let line of lines) {
        const trimmed = line.trim();
        if (trimmed === "") continue;

        if (chapterRegex.test(trimmed)) {
            if (currentChapter.paragraphs.length > 0 || currentChapter.title !== "Giới thiệu / Mở đầu") {
                chapters.push(currentChapter);
            }
            currentChapter = {
                title: trimmed,
                paragraphs: []
            };
        } else {
            currentChapter.paragraphs.push(trimmed);
        }
    }

    if (currentChapter.paragraphs.length > 0 || currentChapter.title !== "Giới thiệu / Mở đầu") {
        chapters.push(currentChapter);
    }

    const title = filename.replace(/\.txt$/i, "");
    return { title, chapters };
}

// ==========================================
// 5. TRÌNH ĐỌC TEXT-TO-SPEECH (TTS)
// ==========================================
// ==========================================
// 5. TRÌNH ĐỌC TEXT-TO-SPEECH (TTS) MULTI-ENGINE
// ==========================================
function initSpeech() {
    // Tải danh sách giọng đọc
    function populateVoices() {
        const voiceSelect = document.getElementById('voice-select');
        if (!voiceSelect) return;

        voiceSelect.innerHTML = '';

        // Luôn có Google Online (dành cho điện thoại TQ)
        const optGoogleFemale = document.createElement('option');
        optGoogleFemale.value = 'Google_Vi_Female';
        optGoogleFemale.textContent = '🔊 Giọng Nữ Tiếng Việt (Google Online - Bắt buộc cho ĐT Trung Quốc)';
        voiceSelect.appendChild(optGoogleFemale);

        // Hỗ trợ ResponsiveVoice
        if (window.responsiveVoice) {
            const optResponsive = document.createElement('option');
            optResponsive.value = 'Responsive_Vi_Female';
            optResponsive.textContent = '🌐 Giọng Nữ (ResponsiveVoice - Hỗ trợ tốt Laptop)';
            voiceSelect.appendChild(optResponsive);
        }

        // Lấy thêm các giọng đọc Offline có sẵn trên hệ điều hành (Đặc biệt cho Windows Laptop)
        let sortedVoices = [];
        if ('speechSynthesis' in window) {
            const voices = speechSynthesis.getVoices();
            const viVoices = voices.filter(v => v.lang && v.lang.toLowerCase().includes('vi'));
            const otherVoices = voices.filter(v => !v.lang || !v.lang.toLowerCase().includes('vi'));
            sortedVoices = [...viVoices, ...otherVoices];
        }
        
        if (sortedVoices.length > 0) {
            const optGroup = document.createElement('optgroup');
            optGroup.label = "Giọng đọc hệ thống (Offline)";
            sortedVoices.forEach(voice => {
                const option = document.createElement('option');
                option.value = voice.name;
                option.textContent = `💻 ${voice.name} (${voice.lang})${voice.localService ? ' [Offline]' : ''}`;
                optGroup.appendChild(option);
            });
            voiceSelect.appendChild(optGroup);
        }

        // Khôi phục cài đặt giọng đã lưu
        if (config.voiceName) {
            voiceSelect.value = config.voiceName;
        } else {
            config.voiceName = 'Google_Vi_Female';
            saveConfig();
        }
    }

    populateVoices();
    if ('speechSynthesis' in window && speechSynthesis.onvoiceschanged !== undefined) {
        speechSynthesis.onvoiceschanged = populateVoices;
    }
}

function highlightParagraph(index) {
    document.querySelectorAll('.paragraph').forEach(p => p.classList.remove('highlight'));
    const activeParagraph = document.querySelector(`.paragraph[data-index="${index}"]`);
    if (activeParagraph) {
        activeParagraph.classList.add('highlight');
    }
}

function scrollParagraphIntoView(index, behavior = 'smooth') {
    const activeParagraph = document.querySelector(`.paragraph[data-index="${index}"]`);
    if (activeParagraph) {
        activeParagraph.scrollIntoView({
            behavior: behavior,
            block: 'center'
        });
    }
}

// Phát âm đoạn văn cụ thể
function speakParagraph(index) {
    if (config.disableWebTTS) return;
    
    if (!currentNovel) return;
    const chapter = currentNovel.chapters[currentChapterIndex];
    if (!chapter || index < 0 || index >= chapter.paragraphs.length) {
        // Đã hết chương
        if (config.autoNextChapter && currentChapterIndex < currentNovel.chapters.length - 1) {
            loadChapter(currentChapterIndex + 1, true);
        } else {
            stopSpeech();
        }
        return;
    }

    currentParagraphIndex = index;
    highlightParagraph(index);
    scrollParagraphIntoView(index);
    saveReadingProgress();

    // Dừng tất cả âm thanh đang phát trước đó
    stopAllAudio();

    const text = chapter.paragraphs[index];
    if (!text || text.trim() === "") {
        speakParagraph(index + 1);
        return;
    }

    // Phân luồng Engine theo Lựa chọn giọng đọc
    if (config.voiceName === 'Google_Vi_Female') {
        speakViaGoogleOnline(text, index);
    } else if (config.voiceName === 'Responsive_Vi_Female') {
        speakViaResponsiveVoice(text, index);
    } else {
        speakViaWebSpeech(text, index);
    }
}

// --- ENGINE 1: GOOGLE ONLINE FEMALE (Dùng no-referrer bypass CORS) ---
function speakViaGoogleOnline(text, index) {
    onlineChunks = chunkTextForTTS(text, 170);
    currentChunkIndex = 0;

    if (onlineChunks.length === 0) {
        speakParagraph(index + 1);
        return;
    }

    playNextGoogleChunk(index);
}

function playNextGoogleChunk(paragraphIndex) {
    if (!isPlaying) return;

    if (currentChunkIndex >= onlineChunks.length) {
        consecutiveErrors = 0;
        speakParagraph(paragraphIndex + 1);
        return;
    }

    const chunkText = onlineChunks[currentChunkIndex];
    const encoded = encodeURIComponent(chunkText);
    
    // Các nguồn phát âm thanh
    const sources = [
        `https://translate.googleapis.com/translate_tts?client=gtx&ie=UTF-8&tl=vi&q=${encoded}`,
        `https://translate.google.com/translate_tts?client=tw-ob&ie=UTF-8&tl=vi&q=${encoded}`,
        `https://dict.youdao.com/dictvoice?audio=${encoded}&le=vi`,
        `https://api.allorigins.win/raw?url=${encodeURIComponent(`https://translate.googleapis.com/translate_tts?client=gtx&ie=UTF-8&tl=vi&q=${encoded}`)}`
    ];

    let currentSourceIndex = 0;
    let audio = document.getElementById('global-audio-player');
    if (!audio) {
        audio = new Audio();
        audio.id = 'global-audio-player';
        document.body.appendChild(audio);
    }
    onlineAudioPlayer = audio;

    // CỰC KỲ QUAN TRỌNG: Bỏ Referer để Google không chặn (Lỗi 403)
    audio.referrerPolicy = "no-referrer";

    // Reset handlers
    audio.onerror = null;
    audio.onended = null;
    audio.onplaying = null;

    let timeoutId = null;
    let isSourceHandled = false;

    const handleSourceFailed = (reason) => {
        if (isSourceHandled) return;
        isSourceHandled = true;
        if (timeoutId) clearTimeout(timeoutId);
        
        console.warn(`Nguồn ${currentSourceIndex} thất bại do: ${reason}. Chuyển nguồn...`);
        audio.src = ""; 
        currentSourceIndex++;
        tryNextSource();
    };

    const tryNextSource = () => {
        if (currentSourceIndex >= sources.length) {
            alert("Lỗi mạng: Không thể kết nối đến máy chủ âm thanh. Vui lòng thử dùng VPN hoặc đổi sang trình duyệt khác!");
            isPlaying = false;
            updatePlayBtnState(false);
            return;
        }

        isSourceHandled = false;
        audio.src = sources[currentSourceIndex];
        audio.defaultPlaybackRate = config.rate || 1.0;
        audio.playbackRate = config.rate || 1.0;
        
        audio.load();

        // Đồng hồ đếm ngược 5s chống treo đơ mạng
        timeoutId = setTimeout(() => {
            handleSourceFailed("Timeout (Quá 5s không phản hồi)");
        }, 5000);

        const playPromise = audio.play();
        if (playPromise !== undefined) {
            playPromise.then(() => {
                // Đã phát thành công, hủy đồng hồ đếm ngược
                if (!isSourceHandled) {
                    isSourceHandled = true;
                    if (timeoutId) clearTimeout(timeoutId);
                }
            }).catch(e => {
                if (e.name === 'NotAllowedError') {
                    if (timeoutId) clearTimeout(timeoutId);
                    isSourceHandled = true;
                    console.warn(`Bị chặn Autoplay:`, e);
                    alert("Trình duyệt chặn phát âm thanh tự động. Vui lòng CHẠM MÀN HÌNH (nhấp vào đoạn văn) 1 lần nữa để cấp quyền.");
                    isPlaying = false;
                    updatePlayBtnState(false);
                } else {
                    handleSourceFailed(`Play Promise bị từ chối (${e.name})`);
                }
            });
        }
    };

    audio.onended = () => {
        if (timeoutId) clearTimeout(timeoutId);
        isSourceHandled = true;
        currentChunkIndex++;
        playNextGoogleChunk(paragraphIndex);
    };

    audio.onerror = () => {
        handleSourceFailed("Lỗi tải mạng/media (onerror)");
    };

    tryNextSource();
    updatePlayBtnState(true);
}

// --- ENGINE 2: RESPONSIVEVOICE (Giọng Nữ chuẩn) ---
function speakViaResponsiveVoice(text, index) {
    if (!window.responsiveVoice) {
        speakViaWebSpeech(text, index);
        return;
    }

    responsiveVoice.speak(text, "Vietnamese Female", {
        rate: config.rate || 1.0,
        pitch: config.pitch || 1.0,
        onend: () => {
            consecutiveErrors = 0;
            if (isPlaying) {
                speakParagraph(index + 1);
            }
        },
        onerror: (err) => {
            console.warn("Lỗi ResponsiveVoice:", err);
            speakViaWebSpeech(text, index);
        }
    });
    updatePlayBtnState(true);
}

// --- ENGINE 3: WEB SPEECH API (Máy / Hệ thống) ---
function speakViaWebSpeech(text, index) {
    if (!('speechSynthesis' in window)) {
        stopSpeech();
        return;
    }

    const utterance = new SpeechSynthesisUtterance(text);
    activeUtterance = utterance;
    utterance.lang = 'vi-VN';

    if (config.voiceName && config.voiceName !== 'Auto_Vi') {
        const selectedVoice = voices.find(v => v.name === config.voiceName);
        if (selectedVoice) {
            utterance.voice = selectedVoice;
        }
    } else {
        const viVoice = voices.find(v => v.lang && v.lang.toLowerCase().includes('vi'));
        if (viVoice) {
            utterance.voice = viVoice;
        }
    }

    utterance.rate = config.rate || 1.0;
    utterance.pitch = config.pitch || 1.0;

    utterance.onend = () => {
        consecutiveErrors = 0;
        activeUtterance = null;
        if (isPlaying) {
            speakParagraph(index + 1);
        }
    };

    utterance.onerror = (e) => {
        activeUtterance = null;
        console.warn("Lỗi WebSpeech:", e.error);

        if (e.error === 'canceled' || e.error === 'interrupted' || !isPlaying) {
            return;
        }

        consecutiveErrors++;
        if (consecutiveErrors >= 3) {
            stopSpeech();
            consecutiveErrors = 0;
            return;
        }

        setTimeout(() => {
            if (isPlaying) {
                speakParagraph(index + 1);
            }
        }, 400);
    };

    if (window.speechSynthesis.paused) {
        window.speechSynthesis.resume();
    }

    window.speechSynthesis.speak(utterance);
    updatePlayBtnState(true);
}

function stopAllAudio() {
    if (activeUtterance) {
        activeUtterance.onend = null;
        activeUtterance.onerror = null;
        activeUtterance = null;
    }
    if ('speechSynthesis' in window) {
        window.speechSynthesis.cancel();
    }
    if (window.responsiveVoice) {
        responsiveVoice.cancel();
    }
    if (onlineAudioPlayer) {
        onlineAudioPlayer.pause();
        onlineAudioPlayer.onended = null;
        onlineAudioPlayer.onerror = null;
        onlineAudioPlayer = null;
    }
}

function togglePlay() {
    if (!currentNovel) return;
    
    if (isPlaying) {
        stopSpeech();
    } else {
        isPlaying = true;
        consecutiveErrors = 0;
        if (currentParagraphIndex < 0) {
            currentParagraphIndex = 0;
        }
        speakParagraph(currentParagraphIndex);
    }
}

function stopSpeech() {
    consecutiveErrors = 0;
    stopAllAudio();
    isPlaying = false;
    updatePlayBtnState(false);
}

// Chia tách văn bản thành các câu nhỏ (<170 kí tự) cho API Google Online
function chunkTextForTTS(text, maxLength) {
    const sentences = text.match(/[^.!?]+[.!?]*|.+/g) || [text];
    const chunks = [];
    let currentChunk = "";

    for (let sentence of sentences) {
        const clean = sentence.trim();
        if (clean === "") continue;

        if (clean.length > maxLength) {
            const words = clean.split(/\s+/);
            for (let word of words) {
                if ((currentChunk + " " + word).trim().length <= maxLength) {
                    currentChunk = (currentChunk + " " + word).trim();
                } else {
                    if (currentChunk) chunks.push(currentChunk);
                    currentChunk = word;
                }
            }
        } else {
            if ((currentChunk + " " + clean).trim().length <= maxLength) {
                currentChunk = (currentChunk + " " + clean).trim();
            } else {
                if (currentChunk) chunks.push(currentChunk);
                currentChunk = clean;
            }
        }
    }
    if (currentChunk) chunks.push(currentChunk);
    return chunks;
}

function updatePlayBtnState(playing) {
    const playIcon = document.getElementById('play-icon');
    if (playing) {
        playIcon.setAttribute('data-lucide', 'pause');
    } else {
        playIcon.setAttribute('data-lucide', 'play');
    }
    lucide.createIcons(); // Vẽ lại icon mới
}

// ==========================================
// 6. QUẢN LÝ ĐÁNH DẤU (Bookmarking)
// ==========================================
function getBookmarks() {
    if (!currentNovel) return [];
    const saved = localStorage.getItem(`bookmarks_${currentNovel.title}`);
    return saved ? JSON.parse(saved) : [];
}

function saveBookmarks(bookmarks) {
    if (!currentNovel) return;
    localStorage.setItem(`bookmarks_${currentNovel.title}`, JSON.stringify(bookmarks));
    renderBookmarks();
}

function addBookmark() {
    if (!currentNovel || currentParagraphIndex < 0) {
        alert("Vui lòng click chọn dòng bạn đang đọc trước khi đánh dấu.");
        return;
    }

    const bookmarks = getBookmarks();
    const chapter = currentNovel.chapters[currentChapterIndex];
    const snippet = chapter.paragraphs[currentParagraphIndex].substring(0, 45) + "...";
    
    // Kiểm tra xem đã tồn tại chưa
    const exists = bookmarks.some(b => b.chapterIndex === currentChapterIndex && b.paragraphIndex === currentParagraphIndex);
    
    if (exists) {
        alert("Đoạn văn này đã được đánh dấu từ trước.");
        return;
    }

    bookmarks.push({
        chapterIndex: currentChapterIndex,
        paragraphIndex: currentParagraphIndex,
        chapterTitle: chapter.title,
        snippet: snippet,
        time: new Date().toLocaleDateString('vi-VN') + " " + new Date().toLocaleTimeString('vi-VN', { hour: '2-digit', minute: '2-digit' })
    });

    saveBookmarks(bookmarks);
    
    // Hiển thị thông báo nhỏ
    const bookmarkBtn = document.getElementById('add-bookmark-btn');
    const originalText = bookmarkBtn.innerHTML;
    bookmarkBtn.innerHTML = '<i data-lucide="check"></i> <span>Đã lưu</span>';
    lucide.createIcons();
    setTimeout(() => {
        bookmarkBtn.innerHTML = originalText;
        lucide.createIcons();
    }, 1500);
}

function deleteBookmark(idx) {
    const bookmarks = getBookmarks();
    bookmarks.splice(idx, 1);
    saveBookmarks(bookmarks);
}

function renderBookmarks() {
    const list = document.getElementById('bookmarks-list');
    list.innerHTML = '';
    
    const bookmarks = getBookmarks();
    
    if (bookmarks.length === 0) {
        list.innerHTML = '<li class="empty-msg">Chưa có đánh dấu nào.</li>';
        return;
    }

    bookmarks.forEach((b, i) => {
        const li = document.createElement('li');
        li.className = 'bookmark-item';
        
        const info = document.createElement('div');
        info.className = 'bookmark-item-text';
        info.innerHTML = `<strong>${b.chapterTitle}</strong><br><small>${b.snippet}</small><br><span style="font-size:0.75rem;opacity:0.7;">${b.time}</span>`;
        
        info.addEventListener('click', () => {
            // Khi click vào bookmark, nhảy tới đúng chương và đoạn văn đó
            stopSpeech();
            document.getElementById('bookmarks-popup').classList.add('hidden');
            document.getElementById('bookmarks-panel-btn').classList.remove('active');
            
            currentChapterIndex = b.chapterIndex;
            currentParagraphIndex = b.paragraphIndex;
            
            loadChapter(currentChapterIndex, false);
            
            setTimeout(() => {
                highlightParagraph(currentParagraphIndex);
                scrollParagraphIntoView(currentParagraphIndex);
                // Tự động đọc từ dòng này
                isPlaying = true;
                speakParagraph(currentParagraphIndex);
            }, 100);
        });

        const delBtn = document.createElement('button');
        delBtn.className = 'bookmark-item-delete';
        delBtn.innerHTML = '<i data-lucide="trash-2"></i>';
        delBtn.addEventListener('click', (e) => {
            e.stopPropagation(); // Ngăn sự kiện click lan truyền lên thẻ li
            deleteBookmark(i);
        });

        li.appendChild(info);
        li.appendChild(delBtn);
        list.appendChild(li);
    });
    
    lucide.createIcons();
}

// ==========================================
// 7. LẮNG NGHE SỰ KIỆN GIAO DIỆN & PHÍM TẮT
// ==========================================
function setupEventListeners() {
    // 7.1 Sidebar Toggle
    const openSidebarBtn = document.getElementById('open-sidebar-btn');
    const closeSidebarBtn = document.getElementById('close-sidebar-btn');
    const sidebar = document.getElementById('sidebar');
    const overlay = document.getElementById('sidebar-overlay');

    openSidebarBtn.addEventListener('click', () => {
        sidebar.classList.add('open');
        overlay.classList.add('open');
    });

    closeSidebarBtn.addEventListener('click', () => {
        sidebar.classList.remove('open');
        overlay.classList.remove('open');
    });

    overlay.addEventListener('click', () => {
        sidebar.classList.remove('open');
        overlay.classList.remove('open');
    });

    // 7.2 File Upload
    const fileUpload = document.getElementById('file-upload');
    fileUpload.addEventListener('change', (e) => {
        const file = e.target.files[0];
        if (!file) return;

        const reader = new FileReader();
        reader.onload = async (event) => {
            const text = event.target.result;
            const parsed = parseTxtFile(text, file.name);
            
            // Lưu vào IndexedDB
            await saveNovelToDB(parsed);
            
            // Đóng sidebar mục lục
            sidebar.classList.remove('open');
            overlay.classList.remove('open');
            
            // Ngừng đọc và load truyện mới
            stopSpeech();
            currentParagraphIndex = -1;
            loadNovel(parsed);
        };
        reader.readAsText(file, 'utf8');
    });

    // 7.3 Playback Panel Controls
    document.getElementById('play-btn').addEventListener('click', togglePlay);
    
    document.getElementById('next-btn').addEventListener('click', () => {
        if (!currentNovel) return;
        speakParagraph(currentParagraphIndex + 1);
    });

    document.getElementById('prev-btn').addEventListener('click', () => {
        if (!currentNovel) return;
        speakParagraph(currentParagraphIndex - 1);
    });

    // 7.4 Bookmarks Actions
    document.getElementById('add-bookmark-btn').addEventListener('click', addBookmark);

    // 7.5 Popup Controls
    const popups = {
        'voice-settings-btn': 'voice-settings-popup',
        'display-settings-btn': 'display-settings-popup',
        'bookmarks-panel-btn': 'bookmarks-popup'
    };

    Object.keys(popups).forEach(btnId => {
        const btn = document.getElementById(btnId);
        const popupId = popups[btnId];
        const popup = document.getElementById(popupId);

        btn.addEventListener('click', (e) => {
            e.stopPropagation();
            
            // Đóng các popup khác
            Object.keys(popups).forEach(otherBtnId => {
                if (otherBtnId !== btnId) {
                    document.getElementById(otherBtnId).classList.remove('active');
                    document.getElementById(popups[otherBtnId]).classList.add('hidden');
                }
            });

            // Toggle popup hiện tại
            btn.classList.toggle('active');
            popup.classList.toggle('hidden');
            
            if (btnId === 'bookmarks-panel-btn' && btn.classList.contains('active')) {
                renderBookmarks();
            }
        });
    });

    // Nhấp ra ngoài đóng popup cài đặt
    document.addEventListener('click', (e) => {
        Object.keys(popups).forEach(btnId => {
            const popupId = popups[btnId];
            const popup = document.getElementById(popupId);
            const btn = document.getElementById(btnId);
            
            if (!popup.classList.contains('hidden') && !popup.contains(e.target) && !btn.contains(e.target)) {
                popup.classList.add('hidden');
                btn.classList.remove('active');
            }
        });
    });

    // 7.6 Voice Settings Sync
    document.getElementById('voice-select').addEventListener('change', (e) => {
        config.voiceName = e.target.value;
        saveConfig();
        // Nếu đang đọc, khởi động lại để đổi giọng đọc ngay
        if (isPlaying) {
            speakParagraph(currentParagraphIndex);
        }
    });

    const rateSlider = document.getElementById('rate-slider');
    rateSlider.addEventListener('input', (e) => {
        const val = parseFloat(e.target.value);
        config.rate = val;
        document.getElementById('rate-value').textContent = `${val.toFixed(1)}x`;
        saveConfig();
    });
    rateSlider.addEventListener('change', () => {
        if (isPlaying) speakParagraph(currentParagraphIndex);
    });

    const pitchSlider = document.getElementById('pitch-slider');
    pitchSlider.addEventListener('input', (e) => {
        const val = parseFloat(e.target.value);
        config.pitch = val;
        document.getElementById('pitch-value').textContent = val.toFixed(1);
        saveConfig();
    });
    pitchSlider.addEventListener('change', () => {
        if (isPlaying) speakParagraph(currentParagraphIndex);
    });

    document.getElementById('auto-next-chapter').addEventListener('change', (e) => {
        config.autoNextChapter = e.target.checked;
        saveConfig();
    });

    const disableWebTTSCheckbox = document.getElementById('disable-web-tts');
    if (disableWebTTSCheckbox) {
        disableWebTTSCheckbox.addEventListener('change', (e) => {
            config.disableWebTTS = e.target.checked;
            saveConfig();
            if (config.disableWebTTS) {
                stopSpeech(); // Ngừng đọc ngay lập tức nếu đang đọc
            }
        });
    }

    // 7.7 Display Settings Sync
    document.querySelectorAll('.theme-option').forEach(btn => {
        btn.addEventListener('click', () => {
            config.theme = btn.dataset.theme;
            applyDisplayConfig();
            saveConfig();
        });
    });

    document.getElementById('font-size-slider').addEventListener('input', (e) => {
        const val = parseInt(e.target.value);
        config.fontSize = val;
        document.getElementById('font-size-value').textContent = `${val}px`;
        document.getElementById('paragraphs-container').style.fontSize = `${val}px`;
        saveConfig();
    });

    document.getElementById('line-height-slider').addEventListener('input', (e) => {
        const val = parseFloat(e.target.value);
        config.lineHeight = val;
        document.getElementById('line-height-value').textContent = val;
        document.getElementById('paragraphs-container').style.lineHeight = val;
        saveConfig();
    });

    // 7.8 Phím tắt bàn phím (Keyboard Shortcuts)
    document.addEventListener('keydown', (e) => {
        // Bỏ qua phím tắt nếu người dùng đang nhập vào select/input
        const activeTag = document.activeElement.tagName.toLowerCase();
        if (activeTag === 'input' || activeTag === 'select' || activeTag === 'textarea') {
            return;
        }

        switch(e.key) {
            case ' ': // Phím cách: Tạm dừng / Tiếp tục phát
                e.preventDefault(); // Tránh cuộn trang
                togglePlay();
                break;
            case 'ArrowRight': // Mũi tên phải: Đoạn tiếp theo
                e.preventDefault();
                if (currentNovel) {
                    isPlaying = true;
                    speakParagraph(currentParagraphIndex + 1);
                }
                break;
            case 'ArrowLeft': // Mũi tên trái: Đoạn trước đó
                e.preventDefault();
                if (currentNovel) {
                    isPlaying = true;
                    speakParagraph(currentParagraphIndex - 1);
                }
                break;
            case 'ArrowDown': // Mũi tên xuống: Chương tiếp theo
                e.preventDefault();
                if (currentNovel && currentChapterIndex < currentNovel.chapters.length - 1) {
                    stopSpeech();
                    currentParagraphIndex = -1;
                    loadChapter(currentChapterIndex + 1, false);
                    document.getElementById('reader-container').scrollTop = 0;
                }
                break;
            case 'ArrowUp': // Mũi tên lên: Chương trước đó
                e.preventDefault();
                if (currentNovel && currentChapterIndex > 0) {
                    stopSpeech();
                    currentParagraphIndex = -1;
                    loadChapter(currentChapterIndex - 1, false);
                    document.getElementById('reader-container').scrollTop = 0;
                }
                break;
        }
    });

    // Tự động lưu tiến trình cuộn trang khi cuộn (Debounce 500ms)
    let scrollTimeout;
    document.getElementById('reader-container').addEventListener('scroll', () => {
        clearTimeout(scrollTimeout);
        scrollTimeout = setTimeout(() => {
            // Chỉ lưu scroll nếu không đang trong chế độ phát (vì chế độ phát tự lưu theo đoạn)
            if (!isPlaying && currentNovel) {
                const savedProgress = localStorage.getItem(`progress_${currentNovel.title}`);
                let progress = {};
                if (savedProgress) progress = JSON.parse(savedProgress);
                progress.scrollTop = document.getElementById('reader-container').scrollTop;
                localStorage.setItem(`progress_${currentNovel.title}`, JSON.stringify(progress));
            }
        }, 500);
    });
}

// ==========================================
// 8. KHỞI CHẠY ỨNG DỤNG
// ==========================================
window.addEventListener('DOMContentLoaded', async () => {
    // 1. Load cấu hình người dùng
    loadConfig();
    
    // 2. Khởi tạo Speech Synthesis
    initSpeech();
    
    // 3. Thiết lập Event Listeners
    setupEventListeners();
    
    // 4. Khởi tạo Database truyện
    await initDB();
    
    // 5. Nạp truyện mặc định hoặc truyện đang đọc dở
    if (config.currentNovelTitle !== 'default' && config.currentNovelTitle !== '') {
        // Thử lấy truyện đang đọc dở từ IndexedDB
        try {
            const savedNovel = await getNovelFromDB(config.currentNovelTitle);
            if (savedNovel) {
                loadNovel(savedNovel);
                return;
            }
        } catch (e) {
            console.error("Lỗi lấy truyện từ DB:", e);
        }
    }
    
    // Nếu không có hoặc lỗi, nạp truyện mặc định (có sẵn từ book_data.js)
    if (window.defaultStory) {
        loadNovel(window.defaultStory);
    } else {
        document.getElementById('novel-title').textContent = "Không tìm thấy truyện";
    }
});
