// ==UserScript==
// @name         ZX - 答题与题目提取工具（融合版）
// @namespace    http://tampermonkey.net/
// @version      4.0
// @description  融合答题助手和题目提取工具，提供完整的答题和题目管理功能
// @author       You
// @match        https://ai.cqzuxia.com/#/evaluation/knowledge-detail/*
// @match        *://admin.cqzuxia.com/*
// @grant        GM_setValue
// @grant        GM_getValue
// @grant        none
// @run-at       document-idle
// ==/UserScript==

(function () {
    'use strict';

    // ========== 全局变量 ==========
    let KNOWLEDGE_BASE = {};
    let isDragging = false;
    let dragOffsetX = 0, dragOffsetY = 0;
    let observer = null;
    let isProcessing = false;
    let lastQuestionText = '';
    let lastAnswerTime = 0;
    const MIN_TIME_BETWEEN_ANSWERS = 800; // 适当增加间隔时间，避免过快点击

    // 题目提取相关变量
    let storedQuestions = [];
    let answerCache = new Map();
    let currentClassID = null;
    let isProcessingExtraction = false; // 添加处理状态标志
    let processingQueue = []; // 处理队列
    let currentProcessingIndex = 0; // 当前处理索引

    // 遍历速度设置
    let traverseSpeed = 200; // 默认速度（毫秒）
    const speedSettings = {
        slow: { delay: 2000, label: '慢速' },
        normal: { delay: 1000, label: '正常' },
        fast: { delay: 500, label: '快速' },
        veryFast: { delay: 50, label: '极快' }
    };

    // 从localStorage加载速度设置
    function loadSpeedSettings() {
        const savedSpeed = localStorage.getItem('traverseSpeed');
        if (savedSpeed) {
            traverseSpeed = parseInt(savedSpeed, 10);
        }
    }

    // 初始化时加载设置
    loadSpeedSettings();

    // ========== 精准解析题库（支持新旧格式，特别优化多选题）==========
    function parseRawText(raw) {
        const lines = raw.split('\n').map(l => l.trim()).filter(l => l);
        const kb = {};
        let currentQuestion = '';
        let currentAnswer = '';
        let inQuestion = false;

        // 尝试新格式解析（优先）
        const newFormatKb = parseNewFormat(raw);
        if (Object.keys(newFormatKb).length > 0) {
            return newFormatKb;
        }

        // 新格式解析失败，尝试旧格式
        for (let i = 0; i < lines.length; i++) {
            const line = lines[i];

            // 新题开始：以数字+）开头（兼容中文括号）
            if (/^\d+[）)]/.test(line)) {
                if (currentQuestion && currentAnswer) {
                    kb[currentQuestion] = currentAnswer;
                    currentQuestion = '';
                    currentAnswer = '';
                }
                currentQuestion = line;
                inQuestion = true;
                continue;
            }

            // 匹配答案行（支持√×和多选AB/AC）
            const ansMatch = line.match(/答案：【([√×ABCD]+)】/);
            if (ansMatch) {
                currentAnswer = ansMatch[1];
                inQuestion = false;
                continue;
            }

            // 跳过选项行（A. B. C. D.）和题型标签
            if (/^[A-D]\.|【[^】]+】/.test(line)) {
                continue;
            }

            // 合并多行题干
            if (inQuestion && currentQuestion) {
                currentQuestion += ' ' + line;
            }
        }

        // 保存最后一题
        if (currentQuestion && currentAnswer) {
            kb[currentQuestion] = currentAnswer;
        }

        // 清理题干：移除【难度】【题型】等标签
        const cleanedKb = {};
        for (const [q, a] of Object.entries(kb)) {
            const cleanQ = q.replace(/【[^】]+】/g, '')
                .replace(/^\d+[）)]\s*/, '')
                .replace(/`/g, '')
                .replace(/\s+/g, ' ')
                .trim();
            if (cleanQ) cleanedKb[cleanQ] = a;
        }

        return cleanedKb;
    }

    // ========== 专门解析新格式题库 ==========
    function parseNewFormat(raw) {
        const blocks = raw.split('---').map(b => b.trim()).filter(b => b);
        const kb = {};

        for (let i = 0; i < blocks.length; i++) {
            const block = blocks[i];

            // 提取题目内容
            const questionMatch = block.match(/###\s+(\d+)\.\s+(.*)/);
            if (!questionMatch) continue;

            let question = questionMatch[2].trim();
            let answer = null;

            // 提取答案（处理多种格式）
            const answerMatch = block.match(/\*\*答案：\*\*\s+([A-D√×]+(?:\s*[、，,]\s*[A-D√×]+)*)/);
            if (answerMatch) {
                // 清理答案字符串，只保留选项字符
                answer = answerMatch[1].replace(/[\s、，,]+/g, '');
            }

            // 尝试其他答案格式
            if (!answer) {
                const altAnswerMatch = block.match(/答案：【([A-D√×]+)】/);
                if (altAnswerMatch) {
                    answer = altAnswerMatch[1];
                }
            }

            // 如果没有找到答案，跳过该题目
            if (!answer) continue;

            // 提取选项内容并添加到题干
            const options = [];
            const optionRegex = /([A-D])\.\s+(.*)/g;
            let optionMatch;

            // 逐行处理
            const lines = block.split('\n').map(l => l.trim()).filter(l => l);
            for (const line of lines) {
                optionMatch = optionRegex.exec(line);
                if (optionMatch) {
                    options.push(optionMatch[2]);
                }
            }

            // 添加选项内容到题干
            if (options.length > 0) {
                question += ' ' + options.join(' ');
            }

            // 添加到题库
            kb[question] = answer;
        }

        return kb;
    }

    // ========== 标准化题目（用于模糊匹配）==========
    function normalize(str) {
        return str.replace(/\s+/g, '')
            .replace(/[（）【】$、]/g, '')
            .replace(/\.|\s/g, '')
            .replace(/`/g, '')
            .toLowerCase();
    }

    // ========== 创建浮动按钮 ==========
    function createFloatingButton() {
        // 检查是否已存在浮动按钮
        if (document.getElementById('floating-toggle-btn')) {
            return;
        }

        const floatingBtn = document.createElement('div');
        floatingBtn.id = 'floating-toggle-btn';
        floatingBtn.innerHTML = '📚';
        floatingBtn.style.cssText = `
            position: fixed;
            bottom: 30px;
            right: 30px;
            width: 60px;
            height: 60px;
            background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
            color: white;
            border-radius: 50%;
            display: flex;
            align-items: center;
            justify-content: center;
            font-size: 28px;
            cursor: pointer;
            box-shadow: 0 8px 25px rgba(102, 126, 234, 0.4);
            z-index: 2147483646;
            transition: all 0.4s cubic-bezier(0.175, 0.885, 0.32, 1.275);
            border: 3px solid rgba(255, 255, 255, 0.2);
            backdrop-filter: blur(4px);
            animation: float 3s ease-in-out infinite;
            text-align: center;
            line-height: 1;
            font-family: "Apple Color Emoji", "Segoe UI Emoji", "Noto Color Emoji", EmojiSymbols, sans-serif;
        `;

        // 添加动画样式
        const style = document.createElement('style');
        style.textContent = `
            @keyframes float {
                0% { transform: translateY(0px); }
                50% { transform: translateY(-10px); }
                100% { transform: translateY(0px); }
            }
        `;
        document.head.appendChild(style);

        // 添加悬停效果
        floatingBtn.addEventListener('mouseenter', () => {
            floatingBtn.style.transform = 'scale(1.15) rotate(10deg)';
            floatingBtn.style.background = 'linear-gradient(135deg, #764ba2 0%, #f953c6 100%)';
            floatingBtn.style.boxShadow = '0 12px 35px rgba(118, 75, 162, 0.5)';
            floatingBtn.style.textAlign = 'center';
            floatingBtn.style.lineHeight = '1';
        });

        floatingBtn.addEventListener('mouseleave', () => {
            floatingBtn.style.transform = 'scale(1) rotate(0deg)';
            floatingBtn.style.background = 'linear-gradient(135deg, #667eea 0%, #764ba2 100%)';
            floatingBtn.style.boxShadow = '0 8px 25px rgba(102, 126, 234, 0.4)';
            floatingBtn.style.textAlign = 'center';
            floatingBtn.style.lineHeight = '1';
        });

        // 点击事件：显示控制面板
        floatingBtn.addEventListener('click', () => {
            const panel = document.getElementById('unified-control-panel');
            if (panel) {
                panel.style.display = 'block';
                floatingBtn.style.display = 'none';
            }
        });

        document.body.appendChild(floatingBtn);
    }

    // ========== 创建统一的控制面板 ==========
    function createUnifiedControlPanel() {
        // 检查是否已存在面板
        if (document.getElementById('unified-control-panel')) {
            return;
        }

        // 创建浮动按钮
        createFloatingButton();

        const panel = document.createElement('div');
        panel.id = 'unified-control-panel';
        panel.style.cssText = `
            position: fixed;
            bottom: 20px;
            right: 20px;
            width: 450px;
            max-height: 80vh;
            background: white;
            border: 1px solid #409eff;
            border-radius: 8px;
            box-shadow: 0 4px 12px rgba(0,0,0,0.3);
            z-index: 2147483647;
            font-family: sans-serif;
            overflow: hidden;
        `;

        // 创建标签页
        panel.innerHTML = `
            <div id="panel-header" style="padding:8px 12px; background:#409eff; color:white; cursor:move; font-weight:bold; display:flex; justify-content:space-between; align-items:center;">
                📚 答题与题目提取工具
                <span id="close-btn" style="cursor:pointer; font-size:18px;">×</span>
            </div>
            <div style="display:flex; background:#f5f7fa;">
                <button class="tab-btn active" data-tab="answer" style="flex:1; padding:10px; border:none; background:#409eff; color:white; cursor:pointer;">答题助手</button>
                <button class="tab-btn" data-tab="extract" style="flex:1; padding:10px; border:none; background:#e1e8ed; color:#333; cursor:pointer;">题目提取</button>
            </div>
            <div id="tab-content" style="padding:12px; overflow:auto; max-height:400px;">
                <!-- 答题助手标签页内容 -->
                <div id="answer-tab" class="tab-pane">
                    <textarea id="kb-input" placeholder="粘贴题库文本（支持足下教育标准格式）" style="width:100%; height:100px; margin-bottom:8px; padding:6px; border:1px solid #ccc; border-radius:4px; font-family:monospace; font-size:13px;"></textarea>
                    <button id="parse-btn" style="width:100%; padding:6px; background:#409eff; color:white; border:none; border-radius:4px; margin-bottom:8px;">✅ 解析题库</button>
                    <div id="kb-count" style="margin-bottom:6px; color:#666; font-size:12px;"></div>
                    <div id="kb-full-list" style="font-size:12px; max-height:200px; overflow:auto; border:1px solid #eee; padding:6px; border-radius:4px; background:#fafafa;"></div>
                </div>
                <!-- 题目提取标签页内容 -->
                <div id="extract-tab" class="tab-pane" style="display:none;">
                    <div style="margin-bottom:10px;">
                        <button id="auto-browse-btn" style="width:100%; padding:8px; background:#409eff; color:white; border:none; border-radius:4px; margin-bottom:8px;">🤖 自动遍历答案</button>
                        <button id="show-questions-btn" style="width:100%; padding:8px; background:#4CAF50; color:white; border:none; border-radius:4px; margin-bottom:8px;">📋 显示题目列表</button>
                        <button id="speed-settings-btn" style="width:100%; padding:8px; background:#FFA726; color:white; border:none; border-radius:4px; margin-bottom:8px;">⚙️ 速度设置</button>
                    </div>
                    <div id="extraction-status" style="padding:8px; background:#f0f0f0; border-radius:4px; font-size:12px;">
                        等待开始提取题目...
                    </div>
                </div>
            </div>
        `;

        document.body.appendChild(panel);

        // 拖拽逻辑
        const header = panel.querySelector('#panel-header');
        header.addEventListener('mousedown', (e) => {
            isDragging = true;
            dragOffsetX = e.clientX - panel.getBoundingClientRect().left;
            dragOffsetY = e.clientY - panel.getBoundingClientRect().top;
            e.preventDefault();
        });

        document.addEventListener('mousemove', (e) => {
            if (!isDragging) return;
            const x = e.clientX - dragOffsetX;
            const y = e.clientY - dragOffsetY;
            panel.style.left = x + 'px';
            panel.style.top = y + 'px';
            panel.style.right = 'auto';
            panel.style.bottom = 'auto';
        });

        document.addEventListener('mouseup', () => isDragging = false);
        panel.querySelector('#close-btn').onclick = () => {
            panel.style.display = 'none';
            // 显示浮动按钮
            const floatingBtn = document.getElementById('floating-toggle-btn');
            if (floatingBtn) {
                floatingBtn.style.display = 'block';
            }
        };

        // 标签页切换逻辑
        const tabButtons = panel.querySelectorAll('.tab-btn');
        tabButtons.forEach(btn => {
            btn.addEventListener('click', () => {
                // 更新按钮样式
                tabButtons.forEach(b => {
                    b.style.background = '#e1e8ed';
                    b.style.color = '#333';
                });
                btn.style.background = '#409eff';
                btn.style.color = 'white';

                // 切换内容显示
                const tabName = btn.getAttribute('data-tab');
                document.querySelectorAll('.tab-pane').forEach(pane => {
                    pane.style.display = 'none';
                });
                document.getElementById(`${tabName}-tab`).style.display = 'block';

                // 更新题目显示按钮状态
                const toggleButton = document.getElementById('question-toggle-btn');
                if (toggleButton) {
                    updateToggleButton(toggleButton);
                }
            });
        });

        // 答题助手相关事件
        panel.querySelector('#parse-btn').onclick = () => {
            const raw = panel.querySelector('#kb-input').value;
            if (!raw.trim()) return;
            KNOWLEDGE_BASE = parseRawText(raw);
            GM_setValue('knowledge_base_raw', raw);
            renderFullList();
        };

        // 题目提取相关事件
        panel.querySelector('#auto-browse-btn').onclick = () => {
            showSpeedSettingsDialog();
        };

        panel.querySelector('#show-questions-btn').onclick = () => {
            if (storedQuestions.length > 0) {
                createQuestionPanel();
            } else {
                alert('请先触发题目加载');
            }
        };

        panel.querySelector('#speed-settings-btn').onclick = () => {
            showSpeedSettingsDialog();
        };

        // 初始化加载
        const saved = GM_getValue('knowledge_base_raw', '');
        if (saved) {
            panel.querySelector('#kb-input').value = saved;
            KNOWLEDGE_BASE = parseRawText(saved);
            renderFullList();
        }

        function renderFullList() {
            const countEl = panel.querySelector('#kb-count');
            const listEl = panel.querySelector('#kb-full-list');
            const count = Object.keys(KNOWLEDGE_BASE).length;
            countEl.textContent = `✅ 成功解析 ${count} 道题`;

            if (count === 0) {
                listEl.innerHTML = '<i style="color:#999;">未识别到有效题目，请检查格式</i>';
                return;
            }

            let html = '<ul style="padding-left:16px; margin:0; font-size:12px; line-height:1.6;">';
            Object.entries(KNOWLEDGE_BASE).forEach(([q, a]) => {
                // 保留代码块显示
                const displayQ = q.replace(/`/g, '<code>').replace(/`/g, '</code>');
                html += `<li><strong style="color:#409eff;">${a}</strong> ${displayQ}</li>`;
            });
            html += '</ul>';
            listEl.innerHTML = html;
        }

        // 更新题目提取状态
        function updateExtractionStatus() {
            const statusEl = panel.querySelector('#extraction-status');
            const validQuestionIds = new Set(storedQuestions.map(q => q.id));
            const filteredCache = Array.from(answerCache.entries()).filter(
                ([qid]) => validQuestionIds.has(qid)
            );

            const total = storedQuestions.length;
            const completed = filteredCache.reduce((count, [qid, opts]) => {
                return count + (opts.length > 0 ? 1 : 0);
            }, 0);

            if (total > 0) {
                statusEl.innerHTML = `
                    <div>已检测到 <strong>${total}</strong> 道题目</div>
                    <div>已提取答案 <strong>${completed}/${total}</strong> 道</div>
                    <div style="margin-top:8px;">
                        <div style="background:#e0e0e0; height:8px; border-radius:4px; overflow:hidden;">
                            <div style="background:#4CAF50; height:100%; width:${(completed / total) * 100}%; transition:width 0.3s;"></div>
                        </div>
                    </div>
                `;
            } else {
                statusEl.innerHTML = '等待开始提取题目...';
            }
        }

        // 定期更新状态
        setInterval(updateExtractionStatus, 1000);
    }

    // ========== 答题确认弹窗 ==========
    function showModal(question, matchedQ, answer) {
        const old = document.getElementById('auto-answer-modal');
        if (old) old.remove();

        // 暂停观察器
        pauseObserver();

        const modal = document.createElement('div');
        modal.id = 'auto-answer-modal';
        modal.style.cssText = `
            position: fixed;
            top: 15%;
            left: 50%;
            transform: translateX(-50%);
            background: white;
            border: 2px solid #409eff;
            border-radius: 8px;
            padding: 16px;
            z-index: 2147483646;
            max-width: 600px;
            box-shadow: 0 4px 12px rgba(0,0,0,0.3);
            font-family: sans-serif;
        `;

        modal.innerHTML = `
            <h3 style="margin:0 0 12px; color:#333;">🤖 自动答题助手</h3>
            <p><strong>当前题目：</strong><br><span style="color:#e74c3c;">${question}</span></p>
            <p><strong>匹配题库：</strong><br>${matchedQ}</p>
            <p><strong>正确答案：</strong><span style="color:green; font-weight:bold;">${answer}</span></p>
            <div style="text-align:right; margin-top:12px;">
                <button id="btn-cancel" style="padding:6px 12px; margin-right:8px; background:#ccc; border:none; border-radius:4px;">取消</button>
                <button id="btn-confirm" style="padding:6px 12px; background:#409eff; color:white; border:none; border-radius:4px;">✅ 确认自动答题</button>
            </div>
        `;

        document.body.appendChild(modal);
        modal.querySelector('#btn-cancel').onclick = () => {
            modal.remove();
            resumeObserver();
        };
        modal.querySelector('#btn-confirm').onclick = () => {
            modal.remove();
            autoSelectAnswer(answer);
            resumeObserver();
        };
    }

    // ========== 自动选择答案 ==========
    function autoSelectAnswer(answerKey) {
        console.log("尝试选择答案:", answerKey);

        const now = Date.now();
        if (now - lastAnswerTime < MIN_TIME_BETWEEN_ANSWERS) {
            console.log("操作过于频繁，跳过本次选择");
            return;
        }
        lastAnswerTime = now;

        // 检测题目类型
        const isMultipleChoice = document.querySelectorAll('.an-item .el-checkbox').length > 0;
        const isSingleChoice = document.querySelectorAll('.an-item .el-radio').length > 0;
        const isJudgment = document.querySelectorAll('.an-item .el-radio__label').length > 0 &&
            (Array.from(document.querySelectorAll('.an-item .el-radio__label')).some(el =>
                el.textContent.includes('正确') || el.textContent.includes('错误')));

        console.log(`题目类型检测: 多选题=${isMultipleChoice}, 单选题=${isSingleChoice}, 判断题=${isJudgment}`);

        // 判断题处理
        if (answerKey === '√' || answerKey === '×') {
            const options = document.querySelectorAll('.an-item .el-radio__label');
            for (const opt of options) {
                const content = opt.querySelector('.option-content')?.textContent || '';
                if ((answerKey === '√' && content.includes('正确')) ||
                    (answerKey === '×' && content.includes('错误'))) {
                    try {
                        // 直接设置选中状态
                        const input = opt.closest('.el-radio')?.querySelector('input[type="radio"]');
                        if (input && !input.checked) {
                            input.click();
                            console.log('✅ 已自动选择判断题答案:', answerKey);
                            return;
                        }
                    } catch (e) {
                        console.error('点击判断题选项失败:', e);
                    }
                }
            }
        }
        // 多选题处理
        else if (answerKey.length > 1 && isMultipleChoice) {
            const keys = answerKey.split('');
            for (const key of keys) {
                const options = document.querySelectorAll('.an-item .option-answer');
                for (const opt of options) {
                    const text = opt.textContent.trim();
                    // 匹配选项开头（A. 选项内容 → 匹配 "A"）
                    if (text.startsWith(key)) {
                        try {
                            // 直接设置选中状态
                            const input = opt.closest('.el-checkbox')?.querySelector('input[type="checkbox"]');
                            if (input && !input.checked) {
                                input.click();
                                console.log(`✅ 已自动选择多选题选项: ${key}`);
                                break; // 选中一个选项后跳出内层循环
                            }
                        } catch (e) {
                            console.error('点击多选题选项失败:', e);
                        }
                    }
                }
            }
        }
        // 单选题处理
        else {
            const keys = answerKey.split('');
            for (const key of keys) {
                // 优先尝试多选题选项（兼容题目类型错误的情况）
                let options = document.querySelectorAll('.an-item .option-answer');
                let found = false;

                for (const opt of options) {
                    const text = opt.textContent.trim();
                    // 匹配选项开头（A. 选项内容 → 匹配 "A"）
                    if (text.startsWith(key)) {
                        try {
                            // 先尝试多选题选项
                            let input = opt.closest('.el-checkbox')?.querySelector('input[type="checkbox"]');
                            if (input && !input.checked) {
                                input.click();
                                console.log(`✅ 已自动选择选项(多选模式): ${key}`);
                                found = true;
                                break;
                            }

                            // 再尝试单选题选项
                            input = opt.closest('.el-radio')?.querySelector('input[type="radio"]');
                            if (input && !input.checked) {
                                input.click();
                                console.log(`✅ 已自动选择选项(单选模式): ${key}`);
                                found = true;
                                break;
                            }
                        } catch (e) {
                            console.error('点击选项失败:', e);
                        }
                    }
                }

                if (found) break;
            }
        }

        console.warn('❌ 未找到可点击的选项');
    }

    // ========== 观察器控制 ==========
    function startObserver() {
        if (observer) {
            observer.disconnect();
        }

        isProcessing = false;

        observer = new MutationObserver(() => {
            // 使用节流控制，防止过于频繁处理
            if (isProcessing) return;

            // 防抖处理
            clearTimeout(observer.throttleTimer);
            observer.throttleTimer = setTimeout(() => {
                isProcessing = true;

                try {
                    const titleEl = document.querySelector('.question-title');
                    if (!titleEl) return;

                    const qText = titleEl.textContent.trim();
                    if (!qText || qText === lastQuestionText) return;

                    // 更新上一个问题文本
                    lastQuestionText = qText;

                    let matchedQ = null, ans = null;
                    const normQ = normalize(qText);
                    for (const [q, a] of Object.entries(KNOWLEDGE_BASE)) {
                        const normKB = normalize(q);
                        // 增强模糊匹配：允许子串匹配
                        if (normQ.includes(normKB) || normKB.includes(normQ)) {
                            matchedQ = q;
                            ans = a;
                            break;
                        }
                    }

                    if (ans) {
                        showModal(qText, matchedQ, ans);
                    }
                } finally {
                    isProcessing = false;
                }
            }, 250); // 适当增加防抖时间，避免误触发
        });

        observer.observe(document.body, { childList: true, subtree: true });
        console.log("已启动题目观察");
    }

    function pauseObserver() {
        if (observer) {
            observer.disconnect();
        }
    }

    function resumeObserver() {
        setTimeout(() => {
            startObserver();
        }, 800); // 适当增加恢复延迟，确保页面完全加载
    }

    // ========== 检查开始确认对话框 ==========
    function checkStartConfirmation() {
        const startModal = document.querySelector('.el-message-box__wrapper');
        if (startModal && startModal.style.display !== 'none') {
            console.log("检测到开始确认对话框，等待用户点击确定...");

            // 监听"确定"按钮点击
            const confirmBtn = startModal.querySelector('.el-button--primary');
            if (confirmBtn) {
                confirmBtn.addEventListener('click', function () {
                    console.log("用户已点击确定，开始监控题目...");

                    // 确保题目区域加载完成
                    setTimeout(() => {
                        startObserver();
                    }, 1200); // 增加延迟，确保页面完全加载
                });
            }
        } else {
            // 没有确认对话框，直接开始观察
            startObserver();
        }
    }

    // ========== 显示速度设置对话框 ==========
    function showSpeedSettingsDialog() {
        // 检查是否已有对话框
        if (document.querySelector('.speed-settings-dialog')) {
            return;
        }

        // 创建对话框样式
        const style = document.createElement('style');
        style.textContent = `
            .speed-settings-dialog {
                position: fixed;
                top: 50%;
                left: 50%;
                transform: translate(-50%, -50%);
                background: linear-gradient(135deg, #ffffff 0%, #f8f9fa 100%);
                padding: 32px;
                border-radius: 16px;
                box-shadow: 0 20px 40px rgba(0, 0, 0, 0.15), 0 0 0 1px rgba(255,255,255,0.1);
                z-index: 2147483647;
                min-width: 380px;
                border: 1px solid rgba(255,255,255,0.2);
                animation: zxDialogSlideIn 0.4s cubic-bezier(0.16, 1, 0.3, 1);
                font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif;
            }

            .speed-settings-overlay {
                position: fixed;
                top: 0;
                left: 0;
                width: 100%;
                height: 100%;
                background: rgba(0, 0, 0, 0.6);
                z-index: 2147483646;
                backdrop-filter: blur(4px);
                animation: zxFadeIn 0.3s ease-out;
            }

            @keyframes zxDialogSlideIn {
                from {
                    opacity: 0;
                    transform: translate(-50%, -50%) scale(0.95);
                }
                to {
                    opacity: 1;
                    transform: translate(-50%, -50%) scale(1);
                }
            }

            @keyframes zxFadeIn {
                from { opacity: 0; }
                to { opacity: 1; }
            }

            .speed-option {
                display: flex;
                align-items: center;
                gap: 12px;
                cursor: pointer;
                padding: 16px 20px;
                border-radius: 12px;
                transition: all 0.3s cubic-bezier(0.4, 0, 0.2, 1);
                background: rgba(255,255,255,0.8);
                border: 2px solid rgba(0,0,0,0.05);
                box-shadow: 0 2px 8px rgba(0,0,0,0.05);
            }

            .speed-option:hover {
                background-color: #f8f9fa;
                border-color: rgba(25, 118, 210, 0.3);
                transform: translateY(-1px);
                box-shadow: 0 4px 12px rgba(0,0,0,0.1);
            }

            .speed-option input[type="radio"] {
                width: 18px;
                height: 18px;
                accent-color: #1976D2;
            }

            .speed-option input[type="radio"]:checked + label {
                color: #1976D2;
                font-weight: 600;
            }

            .speed-option.selected {
                border-color: #1976D2;
                background: rgba(33, 150, 243, 0.05);
            }

            .speed-btn {
                padding: 12px 24px;
                border-radius: 8px;
                cursor: pointer;
                font-size: 14px;
                font-weight: 500;
                transition: all 0.3s cubic-bezier(0.4, 0, 0.2, 1);
                position: relative;
                overflow: hidden;
                border: none;
            }

            .speed-btn::after {
                content: '';
                position: absolute;
                top: 50%;
                left: 50%;
                width: 0;
                height: 0;
                border-radius: 50%;
                background: rgba(255, 255, 255, 0.5);
                transform: translate(-50%, -50%);
                transition: width 0.6s, height 0.6s;
            }

            .speed-btn:active::after {
                width: 300px;
                height: 300px;
            }

            .speed-btn-primary {
                background: linear-gradient(135deg, #1976D2, #2196F3);
                color: white;
                box-shadow: 0 4px 16px rgba(25, 118, 210, 0.3);
            }

            .speed-btn-primary:hover {
                transform: translateY(-1px);
                box-shadow: 0 6px 20px rgba(25, 118, 210, 0.4);
            }

            .speed-btn-secondary {
                border: 1px solid #e0e0e0;
                background: linear-gradient(135deg, #ffffff, #f5f5f5);
                color: #666;
                box-shadow: 0 2px 8px rgba(0,0,0,0.05);
            }

            .speed-btn-secondary:hover {
                transform: translateY(-1px);
                box-shadow: 0 4px 12px rgba(0,0,0,0.1);
            }
        `;
        document.head.appendChild(style);

        const dialog = document.createElement('div');
        dialog.className = 'speed-settings-dialog';

        const title = document.createElement('h3');
        title.textContent = '⚡ 设置遍历速度';
        title.style.cssText = `
            margin: 0 0 24px 0;
            font-size: 20px;
            color: #1976D2;
            font-weight: 600;
            text-align: center;
        `;

        const optionsContainer = document.createElement('div');
        optionsContainer.style.cssText = `
            display: flex;
            flex-direction: column;
            gap: 12px;
            margin-bottom: 28px;
        `;

        // 创建速度选项
        Object.entries(speedSettings).forEach(([key, setting]) => {
            const option = document.createElement('div');
            option.className = 'speed-option';
            if (setting.delay === traverseSpeed) {
                option.classList.add('selected');
            }

            const radio = document.createElement('input');
            radio.type = 'radio';
            radio.name = 'traverseSpeed';
            radio.value = key;
            radio.id = `speed-${key}`;
            if (setting.delay === traverseSpeed) {
                radio.checked = true;
            }

            // 监听选中事件，更新样式
            radio.addEventListener('change', () => {
                document.querySelectorAll('.speed-option').forEach(opt => {
                    opt.classList.remove('selected');
                });
                option.classList.add('selected');
            });

            const label = document.createElement('label');
            label.htmlFor = `speed-${key}`;
            label.textContent = `${setting.label} (延迟${setting.delay}ms)`;
            label.style.cssText = `
                font-size: 15px;
                font-weight: 500;
                color: #333;
                cursor: pointer;
            `;

            option.appendChild(radio);
            option.appendChild(label);
            optionsContainer.appendChild(option);
        });

        const buttonsContainer = document.createElement('div');
        buttonsContainer.style.cssText = `
            display: flex;
            justify-content: flex-end;
            gap: 12px;
        `;

        const cancelButton = document.createElement('button');
        cancelButton.textContent = '取消';
        cancelButton.className = 'speed-btn speed-btn-secondary';

        const startButton = document.createElement('button');
        startButton.textContent = '🚀 开始遍历';
        startButton.className = 'speed-btn speed-btn-primary';

        // 取消按钮事件
        cancelButton.addEventListener('click', () => {
            removeDialog();
        }, { passive: true });

        // 开始遍历按钮事件
        startButton.addEventListener('click', () => {
            const selectedOption = dialog.querySelector('input[name="traverseSpeed"]:checked');
            if (selectedOption) {
                const selectedKey = selectedOption.value;
                traverseSpeed = speedSettings[selectedKey].delay;

                // 保存设置到localStorage
                localStorage.setItem('traverseSpeed', traverseSpeed);

                // 添加开始动画效果
                startButton.textContent = '⏳ 准备中...';
                startButton.disabled = true;
                startButton.classList.add('disabled');

                setTimeout(() => {
                    removeDialog();
                    // 开始遍历
                    autoBrowseAnswers();
                }, 500);
            }
        }, { passive: true });

        // 移除对话框函数
        function removeDialog() {
            dialog.style.animation = 'zxDialogSlideIn 0.3s cubic-bezier(0.16, 1, 0.3, 1) reverse';
            overlay.style.animation = 'zxFadeIn 0.3s ease-out reverse';
            setTimeout(() => {
                if (dialog.parentNode) dialog.parentNode.removeChild(dialog);
                if (overlay.parentNode) overlay.parentNode.removeChild(overlay);
                if (style.parentNode) style.parentNode.removeChild(style);
            }, 250);
        }

        buttonsContainer.appendChild(cancelButton);
        buttonsContainer.appendChild(startButton);

        dialog.appendChild(title);
        dialog.appendChild(optionsContainer);
        dialog.appendChild(buttonsContainer);

        // 添加背景遮罩
        const overlay = document.createElement('div');
        overlay.className = 'speed-settings-overlay';

        // 点击遮罩关闭对话框
        overlay.addEventListener('click', () => {
            removeDialog();
        }, { passive: true });

        // 防止点击对话框内容时关闭
        dialog.addEventListener('click', (e) => {
            e.stopPropagation();
        }, { passive: true });

        document.body.appendChild(overlay);
        document.body.appendChild(dialog);
    }

    // ========== 创建题目面板 ==========
    function createQuestionPanel() {
        const overlay = document.createElement('div');
        overlay.id = 'question-overlay';
        overlay.style.cssText = `
            position: fixed;
            top: 0;
            left: 0;
            width: 100%;
            height: 100%;
            background: rgba(0,0,0,0.6);
            display: flex;
            justify-content: center;
            align-items: center;
            z-index: 2147483647;
            backdrop-filter: blur(4px);
            animation: fadeIn 0.3s ease-out;
        `;

        const container = document.createElement('div');
        container.id = 'question-container';
        container.style.cssText = `
            background: linear-gradient(135deg, #ffffff 0%, #f8f9fa 100%);
            width: 850px;
            max-height: 85vh;
            border-radius: 16px;
            box-shadow: 0 20px 40px rgba(0,0,0,0.15), 0 0 0 1px rgba(255,255,255,0.1);
            overflow-y: auto;
            position: relative;
            border: 1px solid rgba(255,255,255,0.2);
            animation: slideUp 0.4s cubic-bezier(0.16, 1, 0.3, 1);
        `;

        // 添加CSS动画
        const style = document.createElement('style');
        style.textContent = `
            @keyframes fadeIn {
                from { opacity: 0; }
                to { opacity: 1; }
            }
            @keyframes slideUp {
                from {
                    opacity: 0;
                    transform: translateY(30px) scale(0.95);
                }
                to {
                    opacity: 1;
                    transform: translateY(0) scale(1);
                }
            }
            @keyframes pulse {
                0%, 100% { transform: scale(1); }
                50% { transform: scale(1.05); }
            }
            @keyframes bounce {
                0%, 20%, 50%, 80%, 100% { transform: translateY(0); }
                40% { transform: translateY(-10px); }
                60% { transform: translateY(-5px); }
            }
            @keyframes shake {
                0%, 100% { transform: translateX(0); }
                10%, 30%, 50%, 70%, 90% { transform: translateX(-2px); }
                20%, 40%, 60%, 80% { transform: translateX(2px); }
            }
            @keyframes glow {
                0% { box-shadow: 0 0 5px rgba(33, 150, 243, 0.5); }
                50% { box-shadow: 0 0 20px rgba(33, 150, 243, 0.8); }
                100% { box-shadow: 0 0 5px rgba(33, 150, 243, 0.5); }
            }
            .question-block {
                background: rgba(255,255,255,0.8);
                border-radius: 12px;
                padding: 20px;
                margin-bottom: 20px;
                border: 1px solid rgba(0,0,0,0.05);
                transition: all 0.3s cubic-bezier(0.4, 0, 0.2, 1);
                box-shadow: 0 2px 8px rgba(0,0,0,0.05);
                animation: slideUp 0.6s ease-out;
                opacity: 0;
                animation-fill-mode: forwards;
            }
            .question-block:hover {
                transform: translateY(-2px);
                box-shadow: 0 8px 25px rgba(0,0,0,0.1);
                border-color: rgba(25, 118, 210, 0.2);
            }
            .option-item {
                padding: 8px 12px;
                margin: 6px 0;
                border-radius: 8px;
                background: rgba(248, 249, 250, 0.8);
                border-left: 3px solid transparent;
                transition: all 0.3s cubic-bezier(0.4, 0, 0.2, 1);
                position: relative;
                overflow: hidden;
            }
            .option-item::before {
                content: '';
                position: absolute;
                top: 0;
                left: -100%;
                width: 100%;
                height: 100%;
                background: linear-gradient(90deg, transparent, rgba(255,255,255,0.4), transparent);
                transition: left 0.5s;
            }
            .option-item:hover::before {
                left: 100%;
            }
            .option-item:hover {
                background: #f5f5f5;
                border-color: #2196F3;
                transform: translateX(8px) scale(1.02);
                box-shadow: 0 4px 12px rgba(33, 150, 243, 0.2);
            }
            .option-item.correct {
                background: rgba(76, 175, 80, 0.1);
                border-left-color: #4CAF50;
                color: #2E7D32;
                font-weight: 600;
                animation: pulse 0.6s ease-in-out;
            }
            .option-item.correct::after {
                content: '✓';
                position: absolute;
                right: 16px;
                top: 50%;
                transform: translateY(-50%);
                color: #4CAF50;
                font-size: 18px;
                font-weight: bold;
                animation: bounce 0.6s ease-in-out;
            }
            .answer-badge {
                display: inline-block;
                padding: 6px 16px;
                border-radius: 20px;
                font-weight: 600;
                font-size: 14px;
                margin-top: 10px;
                position: relative;
                overflow: hidden;
                transition: all 0.3s ease;
            }
            .answer-badge.single {
                background: linear-gradient(135deg, #E3F2FD, #BBDEFB);
                color: #1976D2;
                border: 1px solid #90CAF9;
                animation: glow 2s ease-in-out infinite;
            }
            .answer-badge.multiple {
                background: linear-gradient(135deg, #FFF3E0, #FFE0B2);
                color: #F57C00;
                border: 1px solid #FFCC02;
                animation: glow 2s ease-in-out infinite;
            }
            .answer-badge:hover {
                transform: scale(1.05);
            }
        `;
        document.head.appendChild(style);

        const closeButton = document.createElement('button');
        closeButton.innerHTML = '✕';
        closeButton.style.cssText = `
            position: absolute;
            top: 20px;
            right: 20px;
            font-size: 18px;
            border: none;
            background: rgba(255,255,255,0.9);
            cursor: pointer;
            z-index: 2147483647;
            color: #666;
            width: 36px;
            height: 36px;
            border-radius: 50%;
            display: flex;
            align-items: center;
            justify-content: center;
            transition: all 0.3s cubic-bezier(0.4, 0, 0.2, 1);
            box-shadow: 0 2px 8px rgba(0,0,0,0.1);
        `;
        closeButton.addEventListener('mouseenter', () => {
            closeButton.style.background = '#f5f5f5';
            closeButton.style.color = '#333';
            closeButton.style.transform = 'scale(1.1)';
        });
        closeButton.addEventListener('mouseleave', () => {
            closeButton.style.background = 'rgba(255,255,255,0.9)';
            closeButton.style.color = '#666';
            closeButton.style.transform = 'scale(1)';
        });
        closeButton.addEventListener('click', () => overlay.remove(), { passive: true });

        const copyButton = document.createElement('button');
        copyButton.innerHTML = '📋 复制Markdown';
        copyButton.style.cssText = `
            position: absolute;
            top: 20px;
            left: 20px;
            font-size: 14px;
            border: 1px solid #1976D2;
            background: linear-gradient(135deg, #ffffff, #e3f2fd);
            cursor: pointer;
            color: #1976D2;
            display: flex;
            align-items: center;
            gap: 6px;
            padding: 8px 16px;
            border-radius: 20px;
            transition: all 0.3s cubic-bezier(0.4, 0, 0.2, 1);
            font-weight: 500;
            box-shadow: 0 2px 8px rgba(25, 118, 210, 0.1);
        `;
        copyButton.setAttribute('title', '复制Markdown格式内容到剪贴板');

        copyButton.addEventListener('click', async () => {
            if (!currentClassID) {
                alert('未检测到有效的classID');
                return;
            }

            let markdown = '';
            storedQuestions.forEach((q, index) => {
                markdown += `\n\n---\n\n### ${index + 1}. ${q.title}\n`;

                const options = answerCache.get(q.id) || [];
                const letters = ['A', 'B', 'C', 'D', 'E', 'F'];
                let correctAnswers = [];

                options.forEach((opt, idx) => {
                    markdown += `${letters[idx] || (idx + 1)}. ${opt.content}\n`;
                    if (opt.isCorrect) correctAnswers.push(letters[idx] || (idx + 1));
                });

                markdown += `\n**答案：** ${correctAnswers.join('、')}\n\n---`;
            });

            markdown = markdown.trim() + '\n';

            try {
                await navigator.clipboard.writeText(markdown);
                copyButton.innerHTML = '<span>✓</span> 已复制';
                copyButton.style.color = '#4CAF50';
                setTimeout(() => {
                    copyButton.innerHTML = '<span>复制Markdown</span>';
                    copyButton.style.color = '#1976D2';
                }, 2000);
            } catch (err) {
                console.error('复制失败:', err);
                copyButton.innerHTML = '<span>✗</span> 复制失败';
                copyButton.style.color = '#F44336';
                setTimeout(() => {
                    copyButton.innerHTML = '<span>复制Markdown</span>';
                    copyButton.style.color = '#1976D2';
                }, 2000);
            }
        }, { passive: true });

        // 添加自动遍历答案按钮
        const autoBrowseButton = document.createElement('button');
        autoBrowseButton.innerHTML = '🤖 自动遍历答案';
        autoBrowseButton.style.cssText = `
            position: absolute;
            top: 20px;
            left: 160px;
            font-size: 14px;
            border: 1px solid #1976D2;
            background: linear-gradient(135deg, #ffffff, #e3f2fd);
            cursor: pointer;
            color: #1976D2;
            display: flex;
            align-items: center;
            gap: 6px;
            padding: 8px 16px;
            border-radius: 20px;
            transition: all 0.3s cubic-bezier(0.4, 0, 0.2, 1);
            font-weight: 500;
            box-shadow: 0 2px 8px rgba(25, 118, 210, 0.1);
        `;
        autoBrowseButton.setAttribute('title', '自动点击每个题目的"查看"按钮，提取答案并关闭窗口');
        autoBrowseButton.addEventListener('click', () => {
            showSpeedSettingsDialog();
        }, { passive: true });

        // 添加手动刷新按钮
        const manualRefreshButton = document.createElement('button');
        manualRefreshButton.innerHTML = '🔄 刷新内容';
        manualRefreshButton.style.cssText = `
            position: absolute;
            top: 20px;
            left: 300px;
            font-size: 14px;
            border: 1px solid #4CAF50;
            background: linear-gradient(135deg, #ffffff, #e8f5e8);
            cursor: pointer;
            color: #4CAF50;
            display: flex;
            align-items: center;
            gap: 6px;
            padding: 8px 16px;
            border-radius: 20px;
            transition: all 0.3s cubic-bezier(0.4, 0, 0.2, 1);
            font-weight: 500;
            box-shadow: 0 2px 8px rgba(76, 175, 80, 0.1);
        `;
        manualRefreshButton.setAttribute('title', '手动刷新题目和答案内容');
        manualRefreshButton.addEventListener('click', () => {
            manualRefreshButton.innerHTML = '⏳ 刷新中...';
            manualRefreshButton.style.color = '#FFA726';

            // 执行刷新
            refreshUIAfterTraversal();

            // 恢复按钮状态
            setTimeout(() => {
                manualRefreshButton.innerHTML = '🔄 刷新内容';
                manualRefreshButton.style.color = '#4CAF50';
            }, 2000);
        }, { passive: true });

        container.appendChild(autoBrowseButton);
        container.appendChild(manualRefreshButton);
        container.appendChild(closeButton);
        container.appendChild(copyButton);

        const list = document.createElement('div');
        list.id = 'questions-list';
        list.style.padding = '32px';
        list.style.paddingTop = '80px';

        storedQuestions.forEach((q, index) => {
            const questionBlock = document.createElement('div');
            questionBlock.className = 'question-block';
            questionBlock.style.marginBottom = '24px';
            questionBlock.style.animationDelay = `${index * 0.1}s`;

            const title = document.createElement('h3');
            title.textContent = `${index + 1}. ${q.title}`;
            title.style.cssText = `
                color: #1976D2;
                margin: 0 0 16px 0;
                font-size: 18px;
                font-weight: 600;
                line-height: 1.4;
            `;

            const optionsContainer = document.createElement('div');
            optionsContainer.style.marginLeft = '0px';

            const answerContainer = document.createElement('div');
            answerContainer.style.marginTop = '16px';
            answerContainer.style.paddingLeft = '0px';
            answerContainer.style.fontSize = '15px';
            answerContainer.style.fontWeight = '600';

            const loadAnswer = async () => {
                if (answerCache.has(q.id)) {
                    renderContent(answerCache.get(q.id));
                    return;
                }

                try {
                    const apiUrl = `/evaluation/api/TeacherEvaluation/GetQuestionAnswerListByQID?classID=${currentClassID}&questionID=${q.id}`;
                    const response = await fetch(apiUrl);
                    const data = await response.json();

                    if (data.success) {
                        const options = data.data.map(opt => ({
                            content: opt.oppentionContent
                                .replace(/<[^>]+>/g, '')
                                .replace(/&nbsp;/g, ' ')
                                .trim(),
                            isCorrect: opt.isTrue
                        }));
                        answerCache.set(q.id, options);
                        renderContent(options);
                    }
                } catch (e) {
                    console.error('选项加载失败:', e);
                    optionsContainer.innerHTML = '<div style="color: red">加载失败</div>';
                }
            };

            const renderContent = (options) => {
                optionsContainer.innerHTML = '';
                answerContainer.innerHTML = '';

                const letters = ['A', 'B', 'C', 'D', 'E', 'F'];
                let correctAnswers = [];

                options.forEach((opt, idx) => {
                    const optionDiv = document.createElement('div');
                    optionDiv.className = 'option-item';
                    if (opt.isCorrect) {
                        optionDiv.classList.add('correct');
                        correctAnswers.push(letters[idx] || String(idx + 1));
                    }

                    const letter = letters[idx] || String(idx + 1);
                    const mark = document.createElement('span');
                    mark.textContent = `${letter}. `;
                    mark.style.fontWeight = '600';
                    mark.style.color = opt.isCorrect ? '#2E7D32' : '#666';

                    const content = document.createTextNode(opt.content);
                    optionDiv.appendChild(mark);
                    optionDiv.appendChild(content);

                    optionsContainer.appendChild(optionDiv);
                });

                // 创建答案标签
                const answerBadge = document.createElement('span');
                answerBadge.className = correctAnswers.length > 1 ? 'answer-badge multiple' : 'answer-badge single';
                answerBadge.textContent = `答案：${correctAnswers.join('、')}`;

                answerContainer.appendChild(answerBadge);
            };

            loadAnswer();
            questionBlock.appendChild(title);
            questionBlock.appendChild(optionsContainer);
            questionBlock.appendChild(answerContainer);
            list.appendChild(questionBlock);
        });

        container.appendChild(list);
        overlay.appendChild(container);
        document.body.appendChild(overlay);
    }

    // ========== 自动遍历答案功能 ==========
    function autoBrowseAnswers() {
        // 防止重复处理
        if (isProcessingExtraction) {
            alert('正在处理中，请稍候...');
            return;
        }

        const viewButtons = document.querySelectorAll('a[style="color: rgb(64, 158, 255);"]');

        if (viewButtons.length === 0) {
            alert('未找到题目查看按钮');
            return;
        }

        // 初始化处理状态
        isProcessingExtraction = true;
        processingQueue = Array.from(viewButtons);
        currentProcessingIndex = 0;

        // 显示进度提示
        const progressDiv = document.createElement('div');
        progressDiv.style.cssText = `
            position: fixed;
            top: 50%;
            left: 50%;
            transform: translate(-50%, -50%);
            background: rgba(0, 0, 0, 0.8);
            color: white;
            padding: 20px;
            border-radius: 10px;
            z-index: 2147483647;
            font-size: 18px;
            text-align: center;
        `;
        progressDiv.textContent = `正在处理题目: 0/${processingQueue.length}`;
        document.body.appendChild(progressDiv);

        // 使用非递归方式处理队列
        processQueueWithDelay(progressDiv);
    }

    // 使用非递归方式处理队列，避免堆栈溢出
    function processQueueWithDelay(progressDiv) {
        const processNext = () => {
            if (currentProcessingIndex >= processingQueue.length) {
                // 处理完成
                isProcessingExtraction = false;
                progressDiv.remove();
                alert(`已完成所有 ${processingQueue.length} 个题目的遍历`);

                // 遍历完成后刷新UI并加载新内容
                setTimeout(() => {
                    refreshUIAfterTraversal();
                }, 1000); // 延迟1秒后刷新UI，确保所有数据已加载

                return;
            }

            const button = processingQueue[currentProcessingIndex];
            currentProcessingIndex++;

            // 更新进度
            progressDiv.textContent = `正在处理题目: ${currentProcessingIndex}/${processingQueue.length}`;

            // 处理当前题目
            processSingleQuestion(button)
                .then(() => {
                    // 使用requestAnimationFrame代替setTimeout，提高性能
                    requestAnimationFrame(processNext);
                })
                .catch(error => {
                    console.error('处理题目时出错:', error);
                    // 即使出错也继续处理下一个
                    requestAnimationFrame(processNext);
                });
        };

        // 开始处理
        requestAnimationFrame(processNext);
    }

    // 处理单个题目
    async function processSingleQuestion(button) {
        try {
            // 点击"查看"按钮
            button.click();

            // 等待弹窗出现
            const modal = await waitForElement('.el-dialog[aria-label="试题详情"]', 3000);

            // 等待内容加载 - 使用用户设置的速度
            await new Promise(resolve => setTimeout(resolve, traverseSpeed));

            // 提取答案信息
            extractAnswerInfo(modal);

            // 尝试关闭弹窗 - 使用更可靠的方法
            await closeDialogImproved(modal);

        } catch (error) {
            console.error('处理单个题目时出错:', error);
            // 不抛出错误，继续处理下一个
        }
    }

    // 彻底改进的弹窗关闭函数
    async function closeDialogImproved(modal) {
        return new Promise((resolve) => {
            // 查找关闭按钮
            const closeButton = modal.querySelector('.el-dialog__headerbtn');

            if (closeButton) {
                // 点击关闭按钮
                closeButton.click();

                // 立即检查弹窗是否已经关闭
                const immediateCheck = () => {
                    if (!document.body.contains(modal)) {
                        resolve();
                        return;
                    }

                    // 如果立即检查没有关闭，使用多种方法继续检查
                    let checkCount = 0;
                    const maxChecks = 10; // 减少检查次数
                    const checkInterval = 50; // 减少检查间隔

                    const checkClosed = () => {
                        checkCount++;

                        // 方法1：检查元素是否还在DOM中
                        if (!document.body.contains(modal)) {
                            resolve();
                            return;
                        }

                        // 方法2：检查弹窗是否隐藏
                        if (modal.style.display === 'none' ||
                            modal.classList.contains('el-dialog__wrapper--hidden') ||
                            window.getComputedStyle(modal).display === 'none') {
                            resolve();
                            return;
                        }

                        // 方法3：检查弹窗的v-show属性
                        if (modal.getAttribute('aria-hidden') === 'true') {
                            resolve();
                            return;
                        }

                        // 方法4：检查弹窗的可见性
                        if (modal.offsetParent === null) {
                            resolve();
                            return;
                        }

                        // 如果达到最大检查次数，强制继续
                        if (checkCount >= maxChecks) {
                            console.warn('弹窗关闭检测超时，强制继续');
                            // 尝试强制关闭
                            try {
                                // 尝试通过ESC键关闭
                                const escEvent = new KeyboardEvent('keydown', {
                                    key: 'Escape',
                                    code: 'Escape',
                                    keyCode: 27,
                                    which: 27,
                                    bubbles: true,
                                    cancelable: true
                                });
                                document.dispatchEvent(escEvent);

                                // 再次检查
                                setTimeout(() => {
                                    if (!document.body.contains(modal)) {
                                        resolve();
                                    } else {
                                        // 最后的强制方法：直接移除DOM元素
                                        if (modal.parentNode) {
                                            modal.parentNode.removeChild(modal);
                                        }
                                        resolve();
                                    }
                                }, 50);
                            } catch (e) {
                                console.error('强制关闭弹窗失败:', e);
                                resolve();
                            }
                            return;
                        }

                        // 继续检查
                        setTimeout(checkClosed, checkInterval);
                    };

                    // 开始检查
                    setTimeout(checkClosed, 20); // 20ms后开始检查
                };

                // 立即检查
                immediateCheck();
            } else {
                // 如果找不到关闭按钮，直接继续
                resolve();
            }
        });
    }

    // 优化后的辅助函数：等待元素出现
    function waitForElement(selector, timeout = 3000) {
        return new Promise((resolve, reject) => {
            const startTime = Date.now();
            const checkInterval = 50; // 减少检查间隔

            const checkElement = () => {
                const element = document.querySelector(selector);
                if (element) {
                    resolve(element);
                } else if (Date.now() - startTime > timeout) {
                    reject(new Error(`元素 ${selector} 超时未找到`));
                } else {
                    setTimeout(checkElement, checkInterval);
                }
            };

            checkElement();
        });
    }

    // 提取答案信息的函数
    function extractAnswerInfo(modal) {
        const questionTitle = modal.querySelector('.questionTitle');
        const answerElements = modal.querySelectorAll('.questionAnswer');

        if (!questionTitle || answerElements.length === 0) {
            return;
        }

        const questionText = questionTitle.textContent.trim();

        // 收集答案信息
        const answers = [];
        answerElements.forEach(answerEl => {
            const letter = answerEl.querySelector('.answerTitle > div')?.textContent?.trim();
            const content = answerEl.querySelector('.answerTitle > div:last-child')?.textContent?.trim();
            const isCorrect = answerEl.querySelector('.answersuccess') !== null;

            if (letter && content) {
                answers.push({
                    letter,
                    content,
                    isCorrect
                });
            }
        });

        // 从题目文本中提取题号
        const questionNumberMatch = questionText.match(/第(\d+)题/);
        let questionNumber = null;
        if (questionNumberMatch) {
            questionNumber = parseInt(questionNumberMatch[1]);
        }

        // 提取答案
        const correctAnswers = answers.filter(a => a.isCorrect).map(a => a.letter);
        console.log(`第${questionNumber || '未知'}题: ${questionText}`);
        console.log(`答案: ${correctAnswers.join(', ')}`);

        // 尝试将答案添加到answerCache
        if (questionNumber && questionNumber <= storedQuestions.length) {
            const questionId = storedQuestions[questionNumber - 1].id;
            if (questionId) {
                const options = answers.map(a => ({
                    content: a.content,
                    isCorrect: a.isCorrect
                }));
                answerCache.set(questionId, options);
            }
        }
    }

    // ========== 遍历完成后刷新UI ==========
    function refreshUIAfterTraversal() {
        console.log('开始刷新UI和加载新内容...');

        // 1. 重新触发API请求获取最新数据
        console.log('重新触发数据加载...');

        // 尝试重新触发页面数据加载
        const refreshButton = document.querySelector('[class*="refresh"], [class*="reload"], button[title*="刷新"]');
        if (refreshButton) {
            console.log('点击刷新按钮重新加载数据...');
            refreshButton.click();
        } else {
            // 如果没有刷新按钮，尝试重新触发当前页面的数据请求
            console.log('尝试重新触发数据请求...');
            // 触发页面重新加载数据（通过重新触发当前路由或重新发送请求）
            setTimeout(() => {
                // 重新触发fetch请求
                if (currentClassID) {
                    const url = `/api/Knowledge/GetKnowQuestionEvaluation?classID=${currentClassID}`;
                    fetch(url)
                        .then(response => response.json())
                        .then(data => {
                            console.log('重新获取数据成功:', data);
                            // 数据会通过interceptFetch自动处理
                        })
                        .catch(error => console.error('重新获取数据失败:', error));
                }
            }, 500);
        }

        // 2. 更新主按钮状态
        const toggleButton = document.querySelector('button[title="显示题目"]');
        if (toggleButton) {
            updateToggleButton(toggleButton);
        }

        // 3. 如果面板是打开的，刷新面板内容
        const existingOverlay = document.querySelector('#question-overlay');
        if (existingOverlay) {
            // 获取当前滚动位置
            const listElement = existingOverlay.querySelector('#questions-list');
            const scrollPosition = listElement?.scrollTop || 0;

            // 关闭现有面板
            existingOverlay.remove();

            // 重新创建面板
            setTimeout(() => {
                createQuestionPanel();

                // 恢复滚动位置
                const newListElement = document.querySelector('#questions-list');
                if (newListElement) {
                    newListElement.scrollTop = scrollPosition;
                }
            }, 1500); // 增加延迟，确保数据加载完成
        }

        console.log('UI刷新完成');
        showCompletionNotification();
    }

    // ========== 统一通知函数 ==========
    function showNotification(message, type = 'success', duration = 3000) {
        // 类型样式配置
        const typeConfig = {
            success: {
                background: 'linear-gradient(135deg, #00C853, #66BB6A)',
                color: 'white',
                icon: '✅',
                boxShadow: '0 8px 24px rgba(0, 200, 83, 0.3)'
            },
            error: {
                background: 'linear-gradient(135deg, #F44336, #EF5350)',
                color: 'white',
                icon: '❌',
                boxShadow: '0 8px 24px rgba(244, 67, 54, 0.3)'
            },
            info: {
                background: 'linear-gradient(135deg, #2196F3, #64B5F6)',
                color: 'white',
                icon: 'ℹ️',
                boxShadow: '0 8px 24px rgba(33, 150, 243, 0.3)'
            },
            warning: {
                background: 'linear-gradient(135deg, #FF9800, #FFB74D)',
                color: 'white',
                icon: '⚠️',
                boxShadow: '0 8px 24px rgba(255, 152, 0, 0.3)'
            }
        };

        const config = typeConfig[type] || typeConfig.success;

        // 移除旧的通知样式（如果存在）
        const oldStyle = document.getElementById('zx-notification-style');
        if (oldStyle) oldStyle.remove();

        // 添加通知样式
        const notificationStyle = document.createElement('style');
        notificationStyle.id = 'zx-notification-style';
        notificationStyle.textContent = `
            @keyframes zxSlideInRight {
                from { transform: translateX(100%); opacity: 0; }
                to { transform: translateX(0); opacity: 1; }
            }
            @keyframes zxSlideOutRight {
                from { transform: translateX(0); opacity: 1; }
                to { transform: translateX(100%); opacity: 0; }
            }
            @keyframes zxSlideInTop {
                from { transform: translateY(-100%); opacity: 0; }
                to { transform: translateY(0); opacity: 1; }
            }
            @keyframes zxSlideOutTop {
                from { transform: translateY(0); opacity: 1; }
                to { transform: translateY(-100%); opacity: 0; }
            }
        `;
        document.head.appendChild(notificationStyle);

        // 创建通知元素
        const notification = document.createElement('div');
        notification.className = 'zx-notification';
        notification.style.cssText = `
            position: fixed;
            top: 20px;
            right: 20px;
            background: ${config.background};
            color: ${config.color};
            padding: 16px 24px;
            border-radius: 12px;
            box-shadow: ${config.boxShadow};
            z-index: 2147483647;
            font-size: 14px;
            font-weight: 600;
            animation: zxSlideInRight 0.5s ease-out;
            backdrop-filter: blur(10px);
            border: 1px solid rgba(255,255,255,0.2);
            display: flex;
            align-items: center;
            gap: 10px;
            max-width: 350px;
            word-break: break-word;
        `;
        notification.innerHTML = `<span>${config.icon}</span><span>${message}</span>`;

        // 添加关闭按钮
        const closeBtn = document.createElement('span');
        closeBtn.innerHTML = '×';
        closeBtn.style.cssText = `
            position: absolute;
            top: 8px;
            right: 12px;
            cursor: pointer;
            font-size: 16px;
            opacity: 0.8;
            transition: opacity 0.2s, transform 0.2s;
        `;
        closeBtn.addEventListener('mouseenter', () => {
            closeBtn.style.opacity = '1';
            closeBtn.style.transform = 'scale(1.1)';
        });
        closeBtn.addEventListener('mouseleave', () => {
            closeBtn.style.opacity = '0.8';
            closeBtn.style.transform = 'scale(1)';
        });
        closeBtn.addEventListener('click', () => {
            removeNotification();
        });
        notification.appendChild(closeBtn);

        document.body.appendChild(notification);

        // 自动移除函数
        function removeNotification() {
            notification.style.animation = 'zxSlideOutRight 0.5s ease-out';
            setTimeout(() => {
                if (notification.parentNode) {
                    notification.parentNode.removeChild(notification);
                }
                if (notificationStyle.parentNode) {
                    notificationStyle.parentNode.removeChild(notificationStyle);
                }
            }, 500);
        }

        // 自动关闭计时器
        setTimeout(removeNotification, duration);

        return notification;
    }

    // ========== 创建题目显示按钮 ==========
    function createToggleButton() {
        // 检查是否已存在按钮
        if (document.getElementById('question-toggle-btn')) {
            return document.getElementById('question-toggle-btn');
        }

        // 添加按钮样式
        const style = document.createElement('style');
        style.textContent = `
            #question-toggle-btn {
                position: fixed;
                bottom: 30px;
                right: 30px;
                z-index: 2147483646;
                padding: 16px 24px;
                background: linear-gradient(135deg, #4CAF50, #66BB6A);
                color: white;
                border: none;
                border-radius: 50px;
                cursor: pointer;
                transition: all 0.3s cubic-bezier(0.4, 0, 0.2, 1);
                font-size: 14px;
                font-weight: 600;
                box-shadow: 0 8px 24px rgba(76, 175, 80, 0.3);
                backdrop-filter: blur(10px);
                border: 1px solid rgba(255,255,255,0.2);
                display: none; /* 默认隐藏，只在需要时显示 */
                font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif;
                position: relative;
                overflow: hidden;
            }

            #question-toggle-btn:hover {
                transform: translateY(-2px) scale(1.05);
                box-shadow: 0 12px 32px rgba(76, 175, 80, 0.4);
                background: linear-gradient(135deg, #66BB6A, #81C784);
            }

            #question-toggle-btn:active {
                transform: translateY(0) scale(0.98);
                box-shadow: 0 4px 16px rgba(76, 175, 80, 0.3);
            }

            #question-toggle-btn .ripple {
                position: absolute;
                border-radius: 50%;
                background: rgba(255, 255, 255, 0.5);
                transform: scale(0);
                animation: zxRipple 0.6s ease-out;
                pointer-events: none;
            }

            @keyframes zxRipple {
                to {
                    transform: scale(4);
                    opacity: 0;
                }
            }

            #question-toggle-btn.badge {
                position: relative;
            }

            #question-toggle-btn .badge-count {
                position: absolute;
                top: -8px;
                right: -8px;
                background: #F44336;
                color: white;
                border-radius: 50%;
                min-width: 24px;
                height: 24px;
                font-size: 12px;
                font-weight: bold;
                display: flex;
                align-items: center;
                justify-content: center;
                box-shadow: 0 2px 8px rgba(244, 67, 54, 0.3);
                animation: zxBadgePulse 1s infinite;
            }

            @keyframes zxBadgePulse {
                0% {
                    transform: scale(1);
                }
                50% {
                    transform: scale(1.1);
                }
                100% {
                    transform: scale(1);
                }
            }
        `;
        document.head.appendChild(style);

        const button = document.createElement('button');
        button.id = 'question-toggle-btn';
        button.textContent = '显示题目 (0/0)';
        button.setAttribute('title', '显示题目列表');

        // 添加点击波纹效果
        button.addEventListener('click', (e) => {
            // 创建波纹元素
            const ripple = document.createElement('span');
            ripple.className = 'ripple';

            // 计算波纹位置和大小
            const rect = button.getBoundingClientRect();
            const size = Math.max(rect.width, rect.height);
            const x = e.clientX - rect.left - size / 2;
            const y = e.clientY - rect.top - size / 2;

            // 设置波纹样式
            ripple.style.width = ripple.style.height = size + 'px';
            ripple.style.left = x + 'px';
            ripple.style.top = y + 'px';

            // 添加波纹并在动画结束后移除
            button.appendChild(ripple);
            setTimeout(() => ripple.remove(), 600);

            // 原有点击逻辑
            if (storedQuestions.length > 0) {
                createQuestionPanel();
            } else {
                showNotification('请先触发题目加载', 'warning');
            }
        }, { passive: true });

        document.body.appendChild(button);
        return button;
    }

    function updateToggleButton(button) {
        if (!button) return;

        // 获取当前活动的标签页
        const activeTab = document.querySelector('.tab-btn.active')?.getAttribute('data-tab');

        // 根据当前标签页显示不同的按钮状态
        if (activeTab === 'extract') {
            // 在答案提取界面时，显示"显示题目 (0/10)"
            const validQuestionIds = new Set(storedQuestions.map(q => q.id));
            const filteredCache = Array.from(answerCache.entries()).filter(
                ([qid]) => validQuestionIds.has(qid)
            );

            const total = storedQuestions.length;
            const completed = filteredCache.reduce((count, [qid, opts]) => {
                return count + (opts.length > 0 ? 1 : 0);
            }, 0);

            if (total > 0) {
                button.textContent = `显示题目 (${completed}/${total})`;
                button.style.display = 'block';

                if (completed === total) {
                    button.style.background = 'linear-gradient(135deg, #00C853, #66BB6A)';
                    button.style.boxShadow = '0 8px 24px rgba(0, 200, 83, 0.3)';
                } else if (completed > 0) {
                    button.style.background = 'linear-gradient(135deg, #FFA726, #FFB74D)';
                    button.style.boxShadow = '0 8px 24px rgba(255, 167, 38, 0.3)';
                } else {
                    button.style.background = 'linear-gradient(135deg, #4CAF50, #66BB6A)';
                    button.style.boxShadow = '0 8px 24px rgba(76, 175, 80, 0.3)';
                }
            } else {
                button.style.display = 'none';
            }
        } else {
            // 在答题界面时，隐藏按钮
            button.style.display = 'none';
        }
    }

    // ========== 拦截网络请求 ==========
    function interceptFetch(toggleButton) {
        const originalFetch = window.fetch;
        window.fetch = async (...args) => {
            try {
                const response = await originalFetch.apply(this, args);
                handleResponse(await response.clone().json(), args[0], toggleButton);
                return response;
            } catch (e) {
                console.error('Fetch请求失败:', e);
                throw e;
            }
        };
    }

    function interceptXHR(toggleButton) {
        const originalOpen = XMLHttpRequest.prototype.open;
        const originalSend = XMLHttpRequest.prototype.send;

        XMLHttpRequest.prototype.open = function (...args) {
            this._url = args[1];
            return originalOpen.apply(this, args);
        };

        XMLHttpRequest.prototype.send = function (...args) {
            this.addEventListener('load', () => {
                try {
                    if (this.readyState === 4 && this.status === 200) {
                        const contentType = this.getResponseHeader('Content-Type');
                        if (contentType && contentType.includes('application/json')) {
                            const response = JSON.parse(this.responseText);
                            handleResponse(response, this._url, toggleButton);
                        }
                    }
                } catch (e) {
                    console.error('XHR处理异常:', e);
                }
            }, { passive: true });

            return originalSend.apply(this, args);
        };
    }

    function handleResponse(response, url, toggleButton) {
        try {
            const fullUrl = new URL(url, window.location.origin);

            if (fullUrl.pathname.endsWith('GetKnowQuestionEvaluation')) {
                console.groupCollapsed('%c题目列表API', 'color: #2196F3');
                currentClassID = fullUrl.searchParams.get('classID');

                if (response.success && Array.isArray(response.data)) {
                    const newQuestionIds = new Set(response.data.map(q => q.QuestionID));

                    for (const qid of answerCache.keys()) {
                        if (!newQuestionIds.has(qid)) {
                            answerCache.delete(qid);
                        }
                    }

                    storedQuestions = response.data.map(q => ({
                        id: q.QuestionID,
                        title: q.QuestionTitle
                            .replace(/<[^>]+>/g, '')
                            .replace(/&nbsp;/g, ' ')
                            .trim(),
                    }));
                    console.log('存储的题目数据:', storedQuestions);
                }
                console.groupEnd();
                updateToggleButton(toggleButton);
            }

            if (fullUrl.pathname.endsWith('GetQuestionAnswerListByQID')) {
                console.groupCollapsed('%c答案选项API', 'color: #FF5722');
                if (response.success && Array.isArray(response.data)) {
                    const questionID = fullUrl.searchParams.get('questionID');

                    if (storedQuestions.some(q => q.id === questionID)) {
                        const options = response.data.map(opt => ({
                            content: opt.oppentionContent
                                .replace(/<[^>]+>/g, '')
                                .replace(/&nbsp;/g, ' ')
                                .trim(),
                            isCorrect: opt.isTrue
                        }));
                        answerCache.set(questionID, options);
                        console.log('存储的答案数据:', { questionID, options });
                    }
                }
                console.groupEnd();
                updateToggleButton(toggleButton);
            }
        } catch (e) {
            console.error('处理失败:', e);
        }
    }

    // ========== 初始化 ==========
    function init() {
        // 创建浮动按钮
        createFloatingButton();
        // 默认显示浮动按钮，因为控制面板默认是隐藏的
        const floatingBtn = document.getElementById('floating-toggle-btn');
        if (floatingBtn) {
            floatingBtn.style.display = 'block';
        }

        // 创建统一控制面板
        createUnifiedControlPanel();

        // 默认隐藏控制面板
        const panel = document.getElementById('unified-control-panel');
        if (panel) {
            panel.style.display = 'none';
        }

        // 创建题目显示按钮
        const toggleButton = createToggleButton();

        // 初始化按钮状态
        setTimeout(() => {
            updateToggleButton(toggleButton);
        }, 500);

        // 拦截网络请求
        interceptFetch(toggleButton);
        interceptXHR(toggleButton);

        // 确保页面完全加载
        if (document.readyState === 'complete' || document.readyState === 'interactive') {
            setTimeout(() => {
                checkStartConfirmation();

                // 确保确认对话框加载完成
                const startModal = document.querySelector('.el-message-box__wrapper');
                if (startModal) {
                    const observer = new MutationObserver(checkStartConfirmation);
                    observer.observe(startModal, { attributes: true });
                }
            }, 2000); // 增加初始延迟，确保页面完全加载
        } else {
            document.addEventListener('DOMContentLoaded', () => {
                setTimeout(() => {
                    checkStartConfirmation();

                    // 确保确认对话框加载完成
                    const startModal = document.querySelector('.el-message-box__wrapper');
                    if (startModal) {
                        const observer = new MutationObserver(checkStartConfirmation);
                        observer.observe(startModal, { attributes: true });
                    }
                }, 1500);
            });
        }
    }

    // 启动脚本
    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', init);
    } else {
        init();
    }
})();// ==UserScript==
// @name         ZX - 答题与题目提取工具（融合版）
// @namespace    http://tampermonkey.net/
// @version      1.0
// @description  融合答题助手和题目提取工具，提供完整的答题和题目管理功能
// @author       You
// @match        https://ai.cqzuxia.com/#/evaluation/knowledge-detail/*
// @match        *://admin.cqzuxia.com/*
// @grant        GM_setValue
// @grant        GM_getValue
// @grant        none
// @run-at       document-idle
// ==/UserScript==

(function () {
    'use strict';

    // ========== 全局变量 ==========
    let KNOWLEDGE_BASE = {};
    let isDragging = false;
    let dragOffsetX = 0, dragOffsetY = 0;
    let observer = null;
    let isProcessing = false;
    let lastQuestionText = '';
    let lastAnswerTime = 0;
    const MIN_TIME_BETWEEN_ANSWERS = 800; // 适当增加间隔时间，避免过快点击

    // 浮动按钮拖拽相关变量
    let isFloatingDragging = false;
    let floatingDragOffsetX = 0;
    let floatingDragOffsetY = 0;

    // 控制面板最小化状态
    let isPanelMinimized = false;

    // 题目提取相关变量
    let storedQuestions = [];
    let answerCache = new Map();
    let currentClassID = null;
    let isProcessingExtraction = false; // 添加处理状态标志
    let processingQueue = []; // 处理队列
    let currentProcessingIndex = 0; // 当前处理索引

    // 遍历速度设置
    let traverseSpeed = 200; // 默认速度（毫秒）
    const speedSettings = {
        slow: { delay: 2000, label: '慢速' },
        normal: { delay: 1000, label: '正常' },
        fast: { delay: 500, label: '快速' },
        veryFast: { delay: 50, label: '极快' }
    };

    // 从localStorage加载速度设置
    function loadSpeedSettings() {
        const savedSpeed = localStorage.getItem('traverseSpeed');
        if (savedSpeed) {
            traverseSpeed = parseInt(savedSpeed, 10);
        }
    }

    // 初始化时加载设置
    loadSpeedSettings();

    // ========== 精准解析题库（支持新旧格式，特别优化多选题）==========
    function parseRawText(raw) {
        const lines = raw.split('\n').map(l => l.trim()).filter(l => l);
        const kb = {};
        let currentQuestion = '';
        let currentAnswer = '';
        let inQuestion = false;

        // 尝试新格式解析（优先）
        const newFormatKb = parseNewFormat(raw);
        if (Object.keys(newFormatKb).length > 0) {
            return newFormatKb;
        }

        // 新格式解析失败，尝试旧格式
        for (let i = 0; i < lines.length; i++) {
            const line = lines[i];

            // 新题开始：以数字+）开头（兼容中文括号）
            if (/^\d+[）)]/.test(line)) {
                if (currentQuestion && currentAnswer) {
                    kb[currentQuestion] = currentAnswer;
                    currentQuestion = '';
                    currentAnswer = '';
                }
                currentQuestion = line;
                inQuestion = true;
                continue;
            }

            // 匹配答案行（支持√×和多选AB/AC）
            const ansMatch = line.match(/答案：【([√×ABCD]+)】/);
            if (ansMatch) {
                currentAnswer = ansMatch[1];
                inQuestion = false;
                continue;
            }

            // 跳过选项行（A. B. C. D.）和题型标签
            if (/^[A-D]\.|【[^】]+】/.test(line)) {
                continue;
            }

            // 合并多行题干
            if (inQuestion && currentQuestion) {
                currentQuestion += ' ' + line;
            }
        }

        // 保存最后一题
        if (currentQuestion && currentAnswer) {
            kb[currentQuestion] = currentAnswer;
        }

        // 清理题干：移除【难度】【题型】等标签
        const cleanedKb = {};
        for (const [q, a] of Object.entries(kb)) {
            const cleanQ = q.replace(/【[^】]+】/g, '')
                .replace(/^\d+[）)]\s*/, '')
                .replace(/`/g, '')
                .replace(/\s+/g, ' ')
                .trim();
            if (cleanQ) cleanedKb[cleanQ] = a;
        }

        return cleanedKb;
    }

    // ========== 专门解析新格式题库 ==========
    function parseNewFormat(raw) {
        const blocks = raw.split('---').map(b => b.trim()).filter(b => b);
        const kb = {};

        for (let i = 0; i < blocks.length; i++) {
            const block = blocks[i];

            // 提取题目内容
            const questionMatch = block.match(/###\s+(\d+)\.\s+(.*)/);
            if (!questionMatch) continue;

            let question = questionMatch[2].trim();
            let answer = null;

            // 提取答案（处理多种格式）
            const answerMatch = block.match(/\*\*答案：\*\*\s+([A-D√×]+(?:\s*[、，,]\s*[A-D√×]+)*)/);
            if (answerMatch) {
                // 清理答案字符串，只保留选项字符
                answer = answerMatch[1].replace(/[\s、，,]+/g, '');
            }

            // 尝试其他答案格式
            if (!answer) {
                const altAnswerMatch = block.match(/答案：【([A-D√×]+)】/);
                if (altAnswerMatch) {
                    answer = altAnswerMatch[1];
                }
            }

            // 如果没有找到答案，跳过该题目
            if (!answer) continue;

            // 提取选项内容并添加到题干
            const options = [];
            const optionRegex = /([A-D])\.\s+(.*)/g;
            let optionMatch;

            // 逐行处理
            const lines = block.split('\n').map(l => l.trim()).filter(l => l);
            for (const line of lines) {
                optionMatch = optionRegex.exec(line);
                if (optionMatch) {
                    options.push(optionMatch[2]);
                }
            }

            // 添加选项内容到题干
            if (options.length > 0) {
                question += ' ' + options.join(' ');
            }

            // 添加到题库
            kb[question] = answer;
        }

        return kb;
    }

    // ========== 标准化题目（用于模糊匹配）==========
    function normalize(str) {
        return str.replace(/\s+/g, '')
            .replace(/[（）【】$、]/g, '')
            .replace(/\.|\s/g, '')
            .replace(/`/g, '')
            .toLowerCase();
    }

    // ========== 创建浮动按钮 ==========
    function createFloatingButton() {
        // 检查是否已存在浮动按钮
        if (document.getElementById('floating-toggle-btn')) {
            return;
        }

        const floatingBtn = document.createElement('div');
        floatingBtn.id = 'floating-toggle-btn';
        floatingBtn.innerHTML = '📚';
        floatingBtn.style.cssText = `
            position: fixed;
            bottom: 30px;
            right: 30px;
            width: 60px;
            height: 60px;
            min-width: 50px;
            min-height: 50px;
            background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
            color: white;
            border-radius: 50%;
            display: flex;
            align-items: center;
            justify-content: center;
            font-size: 28px;
            cursor: move;
            box-shadow: 0 8px 25px rgba(102, 126, 234, 0.4);
            z-index: 2147483646;
            transition: all 0.3s cubic-bezier(0.175, 0.885, 0.32, 1.275);
            border: 3px solid rgba(255, 255, 255, 0.2);
            backdrop-filter: blur(4px);
            animation: float 4s ease-in-out infinite, pulse 3s ease-in-out infinite;
            text-align: center;
            line-height: 1;
            font-family: "Apple Color Emoji", "Segoe UI Emoji", "Noto Color Emoji", EmojiSymbols, sans-serif;
            transform-origin: center;
            will-change: transform, box-shadow;
        `;

        // 添加动画样式和响应式设计
        const style = document.createElement('style');
        style.textContent = `
            @keyframes float {
                0% { transform: translateY(0px) rotate(0deg); }
                25% { transform: translateY(-5px) rotate(1deg); }
                50% { transform: translateY(-10px) rotate(0deg); }
                75% { transform: translateY(-5px) rotate(-1deg); }
                100% { transform: translateY(0px) rotate(0deg); }
            }

            @keyframes pulse {
                0% { box-shadow: 0 8px 25px rgba(102, 126, 234, 0.4); }
                50% { box-shadow: 0 8px 35px rgba(102, 126, 234, 0.6), 0 0 20px rgba(102, 126, 234, 0.3); }
                100% { box-shadow: 0 8px 25px rgba(102, 126, 234, 0.4); }
            }

            @keyframes bounce-in {
                0% { transform: scale(0.3); opacity: 0; }
                50% { transform: scale(1.05); }
                70% { transform: scale(0.9); }
                100% { transform: scale(1); opacity: 1; }
            }

            @media (max-width: 768px) {
                #floating-toggle-btn {
                    width: 55px !important;
                    height: 55px !important;
                    font-size: 24px !important;
                    bottom: 20px !important;
                    right: 20px !important;
                }
            }

            @media (max-width: 480px) {
                #floating-toggle-btn {
                    width: 50px !important;
                    height: 50px !important;
                    font-size: 20px !important;
                    bottom: 15px !important;
                    right: 15px !important;
                }
            }
        `;
        document.head.appendChild(style);

        // 添加悬停效果
        floatingBtn.addEventListener('mouseenter', () => {
            if (!isFloatingDragging) {
                floatingBtn.style.transform = 'scale(1.15) rotate(10deg)';
                floatingBtn.style.background = 'linear-gradient(135deg, #764ba2 0%, #f953c6 100%)';
                floatingBtn.style.boxShadow = '0 12px 35px rgba(118, 75, 162, 0.5), 0 0 25px rgba(118, 75, 162, 0.3)';
                floatingBtn.style.animation = 'none';
                floatingBtn.style.textAlign = 'center';
                floatingBtn.style.lineHeight = '1';
            }
        });

        floatingBtn.addEventListener('mouseleave', () => {
            if (!isFloatingDragging) {
                floatingBtn.style.transform = 'scale(1) rotate(0deg)';
                floatingBtn.style.background = 'linear-gradient(135deg, #667eea 0%, #764ba2 100%)';
                floatingBtn.style.boxShadow = '0 8px 25px rgba(102, 126, 234, 0.4)';
                floatingBtn.style.animation = 'float 4s ease-in-out infinite, pulse 3s ease-in-out infinite';
                floatingBtn.style.textAlign = 'center';
                floatingBtn.style.lineHeight = '1';
            }
        });

        // 添加拖拽功能
        floatingBtn.addEventListener('mousedown', (e) => {
            isFloatingDragging = true;
            floatingDragOffsetX = e.clientX - floatingBtn.getBoundingClientRect().left;
            floatingDragOffsetY = e.clientY - floatingBtn.getBoundingClientRect().top;
            floatingBtn.style.cursor = 'grabbing';
            floatingBtn.style.animation = 'none';
            e.preventDefault();
        });

        // 添加全局鼠标移动事件
        document.addEventListener('mousemove', (e) => {
            if (!isFloatingDragging) return;

            const x = e.clientX - floatingDragOffsetX;
            const y = e.clientY - floatingDragOffsetY;

            // 确保按钮不会拖出屏幕
            const maxX = window.innerWidth - floatingBtn.offsetWidth;
            const maxY = window.innerHeight - floatingBtn.offsetHeight;

            floatingBtn.style.left = Math.max(0, Math.min(x, maxX)) + 'px';
            floatingBtn.style.top = Math.max(0, Math.min(y, maxY)) + 'px';
            floatingBtn.style.right = 'auto';
            floatingBtn.style.bottom = 'auto';
        });

        // 添加全局鼠标释放事件
        document.addEventListener('mouseup', () => {
            if (isFloatingDragging) {
                isFloatingDragging = false;
                floatingBtn.style.cursor = 'move';
                // 保存位置到localStorage
                localStorage.setItem('floatingBtnPosition', JSON.stringify({
                    left: floatingBtn.style.left,
                    top: floatingBtn.style.top,
                    right: floatingBtn.style.right,
                    bottom: floatingBtn.style.bottom
                }));
            }
        });

        // 双击事件：显示控制面板
        floatingBtn.addEventListener('dblclick', () => {
            const panel = document.getElementById('unified-control-panel');
            if (panel) {
                panel.style.display = 'block';
                panel.style.animation = 'slideInUp 0.3s ease-out';
                floatingBtn.style.display = 'none';
                setTimeout(() => {
                    panel.style.animation = '';
                }, 300);
            }
        });

        // 单击事件：显示控制面板（添加延迟以区分双击）
        let clickTimer = null;
        floatingBtn.addEventListener('click', () => {
            if (clickTimer) {
                clearTimeout(clickTimer);
                clickTimer = null;
                return; // 双击时不执行单击操作
            }

            // 添加点击反馈动画
            floatingBtn.style.animation = 'none';
            setTimeout(() => {
                floatingBtn.style.animation = 'bounce-in 0.5s ease-out';
            }, 10);

            clickTimer = setTimeout(() => {
                const panel = document.getElementById('unified-control-panel');
                if (panel) {
                    panel.style.display = 'block';
                    panel.style.animation = 'slideInUp 0.3s ease-out';
                    floatingBtn.style.display = 'none';
                    setTimeout(() => {
                        panel.style.animation = '';
                    }, 300);
                }
                clickTimer = null;
            }, 300);
        });

        // 从localStorage恢复位置
        const savedPosition = localStorage.getItem('floatingBtnPosition');
        if (savedPosition) {
            try {
                const position = JSON.parse(savedPosition);
                Object.assign(floatingBtn.style, position);
            } catch (e) {
                console.error('恢复浮动按钮位置失败:', e);
            }
        }

        document.body.appendChild(floatingBtn);
    }

    // ========== 创建统一的控制面板 ==========
    function createUnifiedControlPanel() {
        // 检查是否已存在面板
        if (document.getElementById('unified-control-panel')) {
            return;
        }

        // 创建浮动按钮
        createFloatingButton();

        const panel = document.createElement('div');
        panel.id = 'unified-control-panel';
        panel.style.cssText = `
            position: fixed;
            bottom: 20px;
            right: 20px;
            width: 450px;
            max-width: 90vw;
            max-height: 80vh;
            background: white;
            border: 1px solid #409eff;
            border-radius: 8px;
            box-shadow: 0 4px 12px rgba(0,0,0,0.3);
            z-index: 2147483647;
            font-family: sans-serif;
            overflow: hidden;
            transition: all 0.3s ease;
        `;

        // 添加响应式样式
        const responsiveStyle = document.createElement('style');
        responsiveStyle.textContent = `
            @keyframes slideInUp {
                from {
                    transform: translateY(100%);
                    opacity: 0;
                }
                to {
                    transform: translateY(0);
                    opacity: 1;
                }
            }

            @keyframes slideOutDown {
                from {
                    transform: translateY(0);
                    opacity: 1;
                }
                to {
                    transform: translateY(100%);
                    opacity: 0;
                }
            }

            @keyframes fadeIn {
                from { opacity: 0; }
                to { opacity: 1; }
            }

            @keyframes bounce-in {
                0% { transform: scale(0.3); opacity: 0; }
                50% { transform: scale(1.05); }
                70% { transform: scale(0.9); }
                100% { transform: scale(1); opacity: 1; }
            }

            @media (max-width: 768px) {
                #unified-control-panel {
                    width: 95vw !important;
                    max-width: 95vw !important;
                    right: 2.5vw !important;
                    left: 2.5vw !important;
                    bottom: 10px !important;
                    max-height: 85vh !important;
                }

                #tab-content {
                    max-height: 60vh !important;
                }

                .tab-btn {
                    font-size: 14px !important;
                    padding: 8px 4px !important;
                }
            }

            @media (max-width: 480px) {
                #unified-control-panel {
                    width: 98vw !important;
                    max-width: 98vw !important;
                    right: 1vw !important;
                    left: 1vw !important;
                    bottom: 5px !important;
                    max-height: 90vh !important;
                }

                #panel-header {
                    padding: 6px 10px !important;
                    font-size: 14px !important;
                }

                #tab-content {
                    padding: 8px !important;
                    max-height: 70vh !important;
                }

                .tab-btn {
                    font-size: 12px !important;
                    padding: 6px 2px !important;
                }

                #kb-input {
                    height: 80px !important;
                    font-size: 12px !important;
                }

                button {
                    font-size: 12px !important;
                    padding: 6px !important;
                }
            }
        `;
        document.head.appendChild(responsiveStyle);

        // 创建标签页
        panel.innerHTML = `
            <div id="panel-header" style="padding:8px 12px; background:#409eff; color:white; cursor:move; font-weight:bold; display:flex; justify-content:space-between; align-items:center;">
                📚 答题与题目提取工具
                <div>
                    <span id="minimize-btn" style="cursor:pointer; font-size:18px; margin-right:8px;">−</span>
                    <span id="close-btn" style="cursor:pointer; font-size:18px;">×</span>
                </div>
            </div>
            <div id="panel-content" style="display:flex; flex-direction:column; background:#f5f7fa;">
                <div style="display:flex;">
                    <button class="tab-btn active" data-tab="answer" style="flex:1; padding:10px; border:none; background:#409eff; color:white; cursor:pointer;">答题助手</button>
                    <button class="tab-btn" data-tab="extract" style="flex:1; padding:10px; border:none; background:#e1e8ed; color:#333; cursor:pointer;">题目提取</button>
                </div>
                <div id="tab-content" style="padding:12px; overflow:auto; max-height:400px;">
                    <!-- 答题助手标签页内容 -->
                    <div id="answer-tab" class="tab-pane">
                        <textarea id="kb-input" placeholder="粘贴题库文本（支持足下教育标准格式）" style="width:100%; height:100px; margin-bottom:8px; padding:6px; border:1px solid #ccc; border-radius:4px; font-family:monospace; font-size:13px;"></textarea>
                        <button id="parse-btn" style="width:100%; padding:6px; background:#409eff; color:white; border:none; border-radius:4px; margin-bottom:8px;">✅ 解析题库</button>
                        <div id="kb-count" style="margin-bottom:6px; color:#666; font-size:12px;"></div>
                        <div id="kb-full-list" style="font-size:12px; max-height:200px; overflow:auto; border:1px solid #eee; padding:6px; border-radius:4px; background:#fafafa;"></div>
                    </div>
                    <!-- 题目提取标签页内容 -->
                    <div id="extract-tab" class="tab-pane" style="display:none;">
                        <div style="margin-bottom:10px;">
                            <button id="auto-browse-btn" style="width:100%; padding:8px; background:#409eff; color:white; border:none; border-radius:4px; margin-bottom:8px;">🤖 自动遍历答案</button>
                            <button id="show-questions-btn" style="width:100%; padding:8px; background:#4CAF50; color:white; border:none; border-radius:4px; margin-bottom:8px;">📋 显示题目列表</button>
                            <button id="speed-settings-btn" style="width:100%; padding:8px; background:#FFA726; color:white; border:none; border-radius:4px; margin-bottom:8px;">⚙️ 速度设置</button>
                        </div>
                        <div id="extraction-status" style="padding:8px; background:#f0f0f0; border-radius:4px; font-size:12px;">
                            等待开始提取题目...
                        </div>
                    </div>
                </div>
            </div>
        `;

        document.body.appendChild(panel);

        // 拖拽逻辑
        const header = panel.querySelector('#panel-header');
        header.addEventListener('mousedown', (e) => {
            isDragging = true;
            dragOffsetX = e.clientX - panel.getBoundingClientRect().left;
            dragOffsetY = e.clientY - panel.getBoundingClientRect().top;
            e.preventDefault();
        });

        document.addEventListener('mousemove', (e) => {
            if (!isDragging) return;
            const x = e.clientX - dragOffsetX;
            const y = e.clientY - dragOffsetY;
            panel.style.left = x + 'px';
            panel.style.top = y + 'px';
            panel.style.right = 'auto';
            panel.style.bottom = 'auto';
        });

        document.addEventListener('mouseup', () => isDragging = false);

        // 最小化按钮事件
        panel.querySelector('#minimize-btn').onclick = () => {
            const panelContent = panel.querySelector('#panel-content');
            const minimizeBtn = panel.querySelector('#minimize-btn');

            if (isPanelMinimized) {
                // 恢复面板
                panelContent.style.display = 'flex';
                panelContent.style.animation = 'fadeIn 0.3s ease-out';
                minimizeBtn.textContent = '−';
                panel.style.height = 'auto';
                panel.style.maxHeight = '80vh';
                isPanelMinimized = false;

                // 保存状态到localStorage
                localStorage.setItem('panelMinimized', 'false');
            } else {
                // 最小化面板
                panelContent.style.animation = 'slideOutDown 0.3s ease-out';
                setTimeout(() => {
                    panelContent.style.display = 'none';
                }, 300);
                minimizeBtn.textContent = '□';
                panel.style.height = 'auto';
                isPanelMinimized = true;

                // 保存状态到localStorage
                localStorage.setItem('panelMinimized', 'true');
            }
        };

        // 关闭按钮事件
        panel.querySelector('#close-btn').onclick = () => {
            panel.style.animation = 'slideOutDown 0.3s ease-out';
            setTimeout(() => {
                panel.style.display = 'none';
                panel.style.animation = '';
                // 显示浮动按钮
                const floatingBtn = document.getElementById('floating-toggle-btn');
                if (floatingBtn) {
                    floatingBtn.style.display = 'block';
                    floatingBtn.style.animation = 'bounce-in 0.5s ease-out';
                    setTimeout(() => {
                        floatingBtn.style.animation = 'float 4s ease-in-out infinite, pulse 3s ease-in-out infinite';
                    }, 500);
                }
            }, 300);
        };

        // 标签页切换逻辑
        const tabButtons = panel.querySelectorAll('.tab-btn');
        tabButtons.forEach(btn => {
            btn.addEventListener('click', () => {
                // 更新按钮样式
                tabButtons.forEach(b => {
                    b.style.background = '#e1e8ed';
                    b.style.color = '#333';
                });
                btn.style.background = '#409eff';
                btn.style.color = 'white';

                // 切换内容显示
                const tabName = btn.getAttribute('data-tab');
                document.querySelectorAll('.tab-pane').forEach(pane => {
                    pane.style.display = 'none';
                });
                document.getElementById(`${tabName}-tab`).style.display = 'block';

                // 更新题目显示按钮状态
                const toggleButton = document.getElementById('question-toggle-btn');
                if (toggleButton) {
                    updateToggleButton(toggleButton);
                }
            });
        });

        // 答题助手相关事件
        panel.querySelector('#parse-btn').onclick = () => {
            const raw = panel.querySelector('#kb-input').value;
            if (!raw.trim()) return;
            KNOWLEDGE_BASE = parseRawText(raw);
            GM_setValue('knowledge_base_raw', raw);
            renderFullList();
        };

        // 题目提取相关事件
        panel.querySelector('#auto-browse-btn').onclick = () => {
            showSpeedSettingsDialog();
        };

        panel.querySelector('#show-questions-btn').onclick = () => {
            if (storedQuestions.length > 0) {
                createQuestionPanel();
            } else {
                alert('请先触发题目加载');
            }
        };

        panel.querySelector('#speed-settings-btn').onclick = () => {
            showSpeedSettingsDialog();
        };

        // 初始化加载
        const saved = GM_getValue('knowledge_base_raw', '');
        if (saved) {
            panel.querySelector('#kb-input').value = saved;
            KNOWLEDGE_BASE = parseRawText(saved);
            renderFullList();
        }

        function renderFullList() {
            const countEl = panel.querySelector('#kb-count');
            const listEl = panel.querySelector('#kb-full-list');
            const count = Object.keys(KNOWLEDGE_BASE).length;
            countEl.textContent = `✅ 成功解析 ${count} 道题`;

            if (count === 0) {
                listEl.innerHTML = '<i style="color:#999;">未识别到有效题目，请检查格式</i>';
                return;
            }

            let html = '<ul style="padding-left:16px; margin:0; font-size:12px; line-height:1.6;">';
            Object.entries(KNOWLEDGE_BASE).forEach(([q, a]) => {
                // 保留代码块显示
                const displayQ = q.replace(/`/g, '<code>').replace(/`/g, '</code>');
                html += `<li><strong style="color:#409eff;">${a}</strong> ${displayQ}</li>`;
            });
            html += '</ul>';
            listEl.innerHTML = html;
        }

        // 更新题目提取状态
        function updateExtractionStatus() {
            const statusEl = panel.querySelector('#extraction-status');
            const validQuestionIds = new Set(storedQuestions.map(q => q.id));
            const filteredCache = Array.from(answerCache.entries()).filter(
                ([qid]) => validQuestionIds.has(qid)
            );

            const total = storedQuestions.length;
            const completed = filteredCache.reduce((count, [qid, opts]) => {
                return count + (opts.length > 0 ? 1 : 0);
            }, 0);

            if (total > 0) {
                statusEl.innerHTML = `
                    <div>已检测到 <strong>${total}</strong> 道题目</div>
                    <div>已提取答案 <strong>${completed}/${total}</strong> 道</div>
                    <div style="margin-top:8px;">
                        <div style="background:#e0e0e0; height:8px; border-radius:4px; overflow:hidden;">
                            <div style="background:#4CAF50; height:100%; width:${(completed / total) * 100}%; transition:width 0.3s;"></div>
                        </div>
                    </div>
                `;
            } else {
                statusEl.innerHTML = '等待开始提取题目...';
            }
        }

        // 定期更新状态
        setInterval(updateExtractionStatus, 1000);
    }

    // ========== 答题确认弹窗 ==========
    function showModal(question, matchedQ, answer) {
        const old = document.getElementById('auto-answer-modal');
        if (old) old.remove();

        // 暂停观察器
        pauseObserver();

        const modal = document.createElement('div');
        modal.id = 'auto-answer-modal';
        modal.style.cssText = `
            position: fixed;
            top: 15%;
            left: 50%;
            transform: translateX(-50%);
            background: white;
            border: 2px solid #409eff;
            border-radius: 8px;
            padding: 16px;
            z-index: 2147483646;
            max-width: 600px;
            box-shadow: 0 4px 12px rgba(0,0,0,0.3);
            font-family: sans-serif;
        `;

        modal.innerHTML = `
            <h3 style="margin:0 0 12px; color:#333;">🤖 自动答题助手</h3>
            <p><strong>当前题目：</strong><br><span style="color:#e74c3c;">${question}</span></p>
            <p><strong>匹配题库：</strong><br>${matchedQ}</p>
            <p><strong>正确答案：</strong><span style="color:green; font-weight:bold;">${answer}</span></p>
            <div style="text-align:right; margin-top:12px;">
                <button id="btn-cancel" style="padding:6px 12px; margin-right:8px; background:#ccc; border:none; border-radius:4px;">取消</button>
                <button id="btn-confirm" style="padding:6px 12px; background:#409eff; color:white; border:none; border-radius:4px;">✅ 确认自动答题</button>
            </div>
        `;

        document.body.appendChild(modal);
        modal.querySelector('#btn-cancel').onclick = () => {
            modal.remove();
            resumeObserver();
        };
        modal.querySelector('#btn-confirm').onclick = () => {
            modal.remove();
            autoSelectAnswer(answer);
            resumeObserver();
        };
    }

    // ========== 自动选择答案 ==========
    function autoSelectAnswer(answerKey) {
        console.log("尝试选择答案:", answerKey);

        const now = Date.now();
        if (now - lastAnswerTime < MIN_TIME_BETWEEN_ANSWERS) {
            console.log("操作过于频繁，跳过本次选择");
            return;
        }
        lastAnswerTime = now;

        // 检测题目类型
        const isMultipleChoice = document.querySelectorAll('.an-item .el-checkbox').length > 0;
        const isSingleChoice = document.querySelectorAll('.an-item .el-radio').length > 0;
        const isJudgment = document.querySelectorAll('.an-item .el-radio__label').length > 0 &&
            (Array.from(document.querySelectorAll('.an-item .el-radio__label')).some(el =>
                el.textContent.includes('正确') || el.textContent.includes('错误')));

        console.log(`题目类型检测: 多选题=${isMultipleChoice}, 单选题=${isSingleChoice}, 判断题=${isJudgment}`);

        // 判断题处理
        if (answerKey === '√' || answerKey === '×') {
            const options = document.querySelectorAll('.an-item .el-radio__label');
            for (const opt of options) {
                const content = opt.querySelector('.option-content')?.textContent || '';
                if ((answerKey === '√' && content.includes('正确')) ||
                    (answerKey === '×' && content.includes('错误'))) {
                    try {
                        // 直接设置选中状态
                        const input = opt.closest('.el-radio')?.querySelector('input[type="radio"]');
                        if (input && !input.checked) {
                            input.click();
                            console.log('✅ 已自动选择判断题答案:', answerKey);
                            return;
                        }
                    } catch (e) {
                        console.error('点击判断题选项失败:', e);
                    }
                }
            }
        }
        // 多选题处理
        else if (answerKey.length > 1 && isMultipleChoice) {
            const keys = answerKey.split('');
            for (const key of keys) {
                const options = document.querySelectorAll('.an-item .option-answer');
                for (const opt of options) {
                    const text = opt.textContent.trim();
                    // 匹配选项开头（A. 选项内容 → 匹配 "A"）
                    if (text.startsWith(key)) {
                        try {
                            // 直接设置选中状态
                            const input = opt.closest('.el-checkbox')?.querySelector('input[type="checkbox"]');
                            if (input && !input.checked) {
                                input.click();
                                console.log(`✅ 已自动选择多选题选项: ${key}`);
                                break; // 选中一个选项后跳出内层循环
                            }
                        } catch (e) {
                            console.error('点击多选题选项失败:', e);
                        }
                    }
                }
            }
        }
        // 单选题处理
        else {
            const keys = answerKey.split('');
            for (const key of keys) {
                // 优先尝试多选题选项（兼容题目类型错误的情况）
                let options = document.querySelectorAll('.an-item .option-answer');
                let found = false;

                for (const opt of options) {
                    const text = opt.textContent.trim();
                    // 匹配选项开头（A. 选项内容 → 匹配 "A"）
                    if (text.startsWith(key)) {
                        try {
                            // 先尝试多选题选项
                            let input = opt.closest('.el-checkbox')?.querySelector('input[type="checkbox"]');
                            if (input && !input.checked) {
                                input.click();
                                console.log(`✅ 已自动选择选项(多选模式): ${key}`);
                                found = true;
                                break;
                            }

                            // 再尝试单选题选项
                            input = opt.closest('.el-radio')?.querySelector('input[type="radio"]');
                            if (input && !input.checked) {
                                input.click();
                                console.log(`✅ 已自动选择选项(单选模式): ${key}`);
                                found = true;
                                break;
                            }
                        } catch (e) {
                            console.error('点击选项失败:', e);
                        }
                    }
                }

                if (found) break;
            }
        }

        console.warn('❌ 未找到可点击的选项');
    }

    // ========== 观察器控制 ==========
    function startObserver() {
        if (observer) {
            observer.disconnect();
        }

        isProcessing = false;

        observer = new MutationObserver(() => {
            // 使用节流控制，防止过于频繁处理
            if (isProcessing) return;

            // 防抖处理
            clearTimeout(observer.throttleTimer);
            observer.throttleTimer = setTimeout(() => {
                isProcessing = true;

                try {
                    const titleEl = document.querySelector('.question-title');
                    if (!titleEl) return;

                    const qText = titleEl.textContent.trim();
                    if (!qText || qText === lastQuestionText) return;

                    // 更新上一个问题文本
                    lastQuestionText = qText;

                    let matchedQ = null, ans = null;
                    const normQ = normalize(qText);
                    for (const [q, a] of Object.entries(KNOWLEDGE_BASE)) {
                        const normKB = normalize(q);
                        // 增强模糊匹配：允许子串匹配
                        if (normQ.includes(normKB) || normKB.includes(normQ)) {
                            matchedQ = q;
                            ans = a;
                            break;
                        }
                    }

                    if (ans) {
                        showModal(qText, matchedQ, ans);
                    }
                } finally {
                    isProcessing = false;
                }
            }, 250); // 适当增加防抖时间，避免误触发
        });

        observer.observe(document.body, { childList: true, subtree: true });
        console.log("已启动题目观察");
    }

    function pauseObserver() {
        if (observer) {
            observer.disconnect();
        }
    }

    function resumeObserver() {
        setTimeout(() => {
            startObserver();
        }, 800); // 适当增加恢复延迟，确保页面完全加载
    }

    // ========== 检查开始确认对话框 ==========
    function checkStartConfirmation() {
        const startModal = document.querySelector('.el-message-box__wrapper');
        if (startModal && startModal.style.display !== 'none') {
            console.log("检测到开始确认对话框，等待用户点击确定...");

            // 监听"确定"按钮点击
            const confirmBtn = startModal.querySelector('.el-button--primary');
            if (confirmBtn) {
                confirmBtn.addEventListener('click', function () {
                    console.log("用户已点击确定，开始监控题目...");

                    // 确保题目区域加载完成
                    setTimeout(() => {
                        startObserver();
                    }, 1200); // 增加延迟，确保页面完全加载
                });
            }
        } else {
            // 没有确认对话框，直接开始观察
            startObserver();
        }
    }

    // ========== 显示速度设置对话框 ==========
    function showSpeedSettingsDialog() {
        // 检查是否已有对话框
        if (document.querySelector('.speed-settings-dialog')) {
            return;
        }

        // 创建对话框样式
        const style = document.createElement('style');
        style.textContent = `
            .speed-settings-dialog {
                position: fixed;
                top: 50%;
                left: 50%;
                transform: translate(-50%, -50%);
                background: linear-gradient(135deg, #ffffff 0%, #f8f9fa 100%);
                padding: 32px;
                border-radius: 16px;
                box-shadow: 0 20px 40px rgba(0, 0, 0, 0.15), 0 0 0 1px rgba(255,255,255,0.1);
                z-index: 2147483647;
                min-width: 380px;
                border: 1px solid rgba(255,255,255,0.2);
                animation: zxDialogSlideIn 0.4s cubic-bezier(0.16, 1, 0.3, 1);
                font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif;
            }

            .speed-settings-overlay {
                position: fixed;
                top: 0;
                left: 0;
                width: 100%;
                height: 100%;
                background: rgba(0, 0, 0, 0.6);
                z-index: 2147483646;
                backdrop-filter: blur(4px);
                animation: zxFadeIn 0.3s ease-out;
            }

            @keyframes zxDialogSlideIn {
                from {
                    opacity: 0;
                    transform: translate(-50%, -50%) scale(0.95);
                }
                to {
                    opacity: 1;
                    transform: translate(-50%, -50%) scale(1);
                }
            }

            @keyframes zxFadeIn {
                from { opacity: 0; }
                to { opacity: 1; }
            }

            .speed-option {
                display: flex;
                align-items: center;
                gap: 12px;
                cursor: pointer;
                padding: 16px 20px;
                border-radius: 12px;
                transition: all 0.3s cubic-bezier(0.4, 0, 0.2, 1);
                background: rgba(255,255,255,0.8);
                border: 2px solid rgba(0,0,0,0.05);
                box-shadow: 0 2px 8px rgba(0,0,0,0.05);
            }

            .speed-option:hover {
                background-color: #f8f9fa;
                border-color: rgba(25, 118, 210, 0.3);
                transform: translateY(-1px);
                box-shadow: 0 4px 12px rgba(0,0,0,0.1);
            }

            .speed-option input[type="radio"] {
                width: 18px;
                height: 18px;
                accent-color: #1976D2;
            }

            .speed-option input[type="radio"]:checked + label {
                color: #1976D2;
                font-weight: 600;
            }

            .speed-option.selected {
                border-color: #1976D2;
                background: rgba(33, 150, 243, 0.05);
            }

            .speed-btn {
                padding: 12px 24px;
                border-radius: 8px;
                cursor: pointer;
                font-size: 14px;
                font-weight: 500;
                transition: all 0.3s cubic-bezier(0.4, 0, 0.2, 1);
                position: relative;
                overflow: hidden;
                border: none;
            }

            .speed-btn::after {
                content: '';
                position: absolute;
                top: 50%;
                left: 50%;
                width: 0;
                height: 0;
                border-radius: 50%;
                background: rgba(255, 255, 255, 0.5);
                transform: translate(-50%, -50%);
                transition: width 0.6s, height 0.6s;
            }

            .speed-btn:active::after {
                width: 300px;
                height: 300px;
            }

            .speed-btn-primary {
                background: linear-gradient(135deg, #1976D2, #2196F3);
                color: white;
                box-shadow: 0 4px 16px rgba(25, 118, 210, 0.3);
            }

            .speed-btn-primary:hover {
                transform: translateY(-1px);
                box-shadow: 0 6px 20px rgba(25, 118, 210, 0.4);
            }

            .speed-btn-secondary {
                border: 1px solid #e0e0e0;
                background: linear-gradient(135deg, #ffffff, #f5f5f5);
                color: #666;
                box-shadow: 0 2px 8px rgba(0,0,0,0.05);
            }

            .speed-btn-secondary:hover {
                transform: translateY(-1px);
                box-shadow: 0 4px 12px rgba(0,0,0,0.1);
            }
        `;
        document.head.appendChild(style);

        const dialog = document.createElement('div');
        dialog.className = 'speed-settings-dialog';

        const title = document.createElement('h3');
        title.textContent = '⚡ 设置遍历速度';
        title.style.cssText = `
            margin: 0 0 24px 0;
            font-size: 20px;
            color: #1976D2;
            font-weight: 600;
            text-align: center;
        `;

        const optionsContainer = document.createElement('div');
        optionsContainer.style.cssText = `
            display: flex;
            flex-direction: column;
            gap: 12px;
            margin-bottom: 28px;
        `;

        // 创建速度选项
        Object.entries(speedSettings).forEach(([key, setting]) => {
            const option = document.createElement('div');
            option.className = 'speed-option';
            if (setting.delay === traverseSpeed) {
                option.classList.add('selected');
            }

            const radio = document.createElement('input');
            radio.type = 'radio';
            radio.name = 'traverseSpeed';
            radio.value = key;
            radio.id = `speed-${key}`;
            if (setting.delay === traverseSpeed) {
                radio.checked = true;
            }

            // 监听选中事件，更新样式
            radio.addEventListener('change', () => {
                document.querySelectorAll('.speed-option').forEach(opt => {
                    opt.classList.remove('selected');
                });
                option.classList.add('selected');
            });

            const label = document.createElement('label');
            label.htmlFor = `speed-${key}`;
            label.textContent = `${setting.label} (延迟${setting.delay}ms)`;
            label.style.cssText = `
                font-size: 15px;
                font-weight: 500;
                color: #333;
                cursor: pointer;
            `;

            option.appendChild(radio);
            option.appendChild(label);
            optionsContainer.appendChild(option);
        });

        const buttonsContainer = document.createElement('div');
        buttonsContainer.style.cssText = `
            display: flex;
            justify-content: flex-end;
            gap: 12px;
        `;

        const cancelButton = document.createElement('button');
        cancelButton.textContent = '取消';
        cancelButton.className = 'speed-btn speed-btn-secondary';

        const startButton = document.createElement('button');
        startButton.textContent = '🚀 开始遍历';
        startButton.className = 'speed-btn speed-btn-primary';

        // 取消按钮事件
        cancelButton.addEventListener('click', () => {
            removeDialog();
        }, { passive: true });

        // 开始遍历按钮事件
        startButton.addEventListener('click', () => {
            const selectedOption = dialog.querySelector('input[name="traverseSpeed"]:checked');
            if (selectedOption) {
                const selectedKey = selectedOption.value;
                traverseSpeed = speedSettings[selectedKey].delay;

                // 保存设置到localStorage
                localStorage.setItem('traverseSpeed', traverseSpeed);

                // 添加开始动画效果
                startButton.textContent = '⏳ 准备中...';
                startButton.disabled = true;
                startButton.classList.add('disabled');

                setTimeout(() => {
                    removeDialog();
                    // 开始遍历
                    autoBrowseAnswers();
                }, 500);
            }
        }, { passive: true });

        // 移除对话框函数
        function removeDialog() {
            dialog.style.animation = 'zxDialogSlideIn 0.3s cubic-bezier(0.16, 1, 0.3, 1) reverse';
            overlay.style.animation = 'zxFadeIn 0.3s ease-out reverse';
            setTimeout(() => {
                if (dialog.parentNode) dialog.parentNode.removeChild(dialog);
                if (overlay.parentNode) overlay.parentNode.removeChild(overlay);
                if (style.parentNode) style.parentNode.removeChild(style);
            }, 250);
        }

        buttonsContainer.appendChild(cancelButton);
        buttonsContainer.appendChild(startButton);

        dialog.appendChild(title);
        dialog.appendChild(optionsContainer);
        dialog.appendChild(buttonsContainer);

        // 添加背景遮罩
        const overlay = document.createElement('div');
        overlay.className = 'speed-settings-overlay';

        // 点击遮罩关闭对话框
        overlay.addEventListener('click', () => {
            removeDialog();
        }, { passive: true });

        // 防止点击对话框内容时关闭
        dialog.addEventListener('click', (e) => {
            e.stopPropagation();
        }, { passive: true });

        document.body.appendChild(overlay);
        document.body.appendChild(dialog);
    }

    // ========== 创建题目面板 ==========
    function createQuestionPanel() {
        const overlay = document.createElement('div');
        overlay.id = 'question-overlay';
        overlay.style.cssText = `
            position: fixed;
            top: 0;
            left: 0;
            width: 100%;
            height: 100%;
            background: rgba(0,0,0,0.6);
            display: flex;
            justify-content: center;
            align-items: center;
            z-index: 2147483647;
            backdrop-filter: blur(4px);
            animation: fadeIn 0.3s ease-out;
        `;

        const container = document.createElement('div');
        container.id = 'question-container';
        container.style.cssText = `
            background: linear-gradient(135deg, #ffffff 0%, #f8f9fa 100%);
            width: 850px;
            max-height: 85vh;
            border-radius: 16px;
            box-shadow: 0 20px 40px rgba(0,0,0,0.15), 0 0 0 1px rgba(255,255,255,0.1);
            overflow-y: auto;
            position: relative;
            border: 1px solid rgba(255,255,255,0.2);
            animation: slideUp 0.4s cubic-bezier(0.16, 1, 0.3, 1);
        `;

        // 添加CSS动画
        const style = document.createElement('style');
        style.textContent = `
            @keyframes fadeIn {
                from { opacity: 0; }
                to { opacity: 1; }
            }
            @keyframes slideUp {
                from {
                    opacity: 0;
                    transform: translateY(30px) scale(0.95);
                }
                to {
                    opacity: 1;
                    transform: translateY(0) scale(1);
                }
            }
            @keyframes pulse {
                0%, 100% { transform: scale(1); }
                50% { transform: scale(1.05); }
            }
            @keyframes bounce {
                0%, 20%, 50%, 80%, 100% { transform: translateY(0); }
                40% { transform: translateY(-10px); }
                60% { transform: translateY(-5px); }
            }
            @keyframes shake {
                0%, 100% { transform: translateX(0); }
                10%, 30%, 50%, 70%, 90% { transform: translateX(-2px); }
                20%, 40%, 60%, 80% { transform: translateX(2px); }
            }
            @keyframes glow {
                0% { box-shadow: 0 0 5px rgba(33, 150, 243, 0.5); }
                50% { box-shadow: 0 0 20px rgba(33, 150, 243, 0.8); }
                100% { box-shadow: 0 0 5px rgba(33, 150, 243, 0.5); }
            }
            .question-block {
                background: rgba(255,255,255,0.8);
                border-radius: 12px;
                padding: 20px;
                margin-bottom: 20px;
                border: 1px solid rgba(0,0,0,0.05);
                transition: all 0.3s cubic-bezier(0.4, 0, 0.2, 1);
                box-shadow: 0 2px 8px rgba(0,0,0,0.05);
                animation: slideUp 0.6s ease-out;
                opacity: 0;
                animation-fill-mode: forwards;
            }
            .question-block:hover {
                transform: translateY(-2px);
                box-shadow: 0 8px 25px rgba(0,0,0,0.1);
                border-color: rgba(25, 118, 210, 0.2);
            }
            .option-item {
                padding: 8px 12px;
                margin: 6px 0;
                border-radius: 8px;
                background: rgba(248, 249, 250, 0.8);
                border-left: 3px solid transparent;
                transition: all 0.3s cubic-bezier(0.4, 0, 0.2, 1);
                position: relative;
                overflow: hidden;
            }
            .option-item::before {
                content: '';
                position: absolute;
                top: 0;
                left: -100%;
                width: 100%;
                height: 100%;
                background: linear-gradient(90deg, transparent, rgba(255,255,255,0.4), transparent);
                transition: left 0.5s;
            }
            .option-item:hover::before {
                left: 100%;
            }
            .option-item:hover {
                background: #f5f5f5;
                border-color: #2196F3;
                transform: translateX(8px) scale(1.02);
                box-shadow: 0 4px 12px rgba(33, 150, 243, 0.2);
            }
            .option-item.correct {
                background: rgba(76, 175, 80, 0.1);
                border-left-color: #4CAF50;
                color: #2E7D32;
                font-weight: 600;
                animation: pulse 0.6s ease-in-out;
            }
            .option-item.correct::after {
                content: '✓';
                position: absolute;
                right: 16px;
                top: 50%;
                transform: translateY(-50%);
                color: #4CAF50;
                font-size: 18px;
                font-weight: bold;
                animation: bounce 0.6s ease-in-out;
            }
            .answer-badge {
                display: inline-block;
                padding: 6px 16px;
                border-radius: 20px;
                font-weight: 600;
                font-size: 14px;
                margin-top: 10px;
                position: relative;
                overflow: hidden;
                transition: all 0.3s ease;
            }
            .answer-badge.single {
                background: linear-gradient(135deg, #E3F2FD, #BBDEFB);
                color: #1976D2;
                border: 1px solid #90CAF9;
                animation: glow 2s ease-in-out infinite;
            }
            .answer-badge.multiple {
                background: linear-gradient(135deg, #FFF3E0, #FFE0B2);
                color: #F57C00;
                border: 1px solid #FFCC02;
                animation: glow 2s ease-in-out infinite;
            }
            .answer-badge:hover {
                transform: scale(1.05);
            }
        `;
        document.head.appendChild(style);

        // 创建点击波纹效果样式
        const rippleStyle = document.createElement('style');
        rippleStyle.id = 'zx-ripple-style';
        rippleStyle.textContent = `
            .ripple {
                position: absolute;
                border-radius: 50%;
                background: rgba(255, 255, 255, 0.5);
                transform: scale(0);
                animation: zxRipple 0.6s ease-out;
                pointer-events: none;
            }
            @keyframes zxRipple {
                to {
                    transform: scale(4);
                    opacity: 0;
                }
            }
        `;
        document.head.appendChild(rippleStyle);

        // 创建关闭按钮
        const closeButton = document.createElement('button');
        closeButton.innerHTML = '✕';
        closeButton.style.cssText = `
            position: absolute;
            top: 20px;
            right: 20px;
            font-size: 18px;
            border: none;
            background: rgba(255,255,255,0.9);
            cursor: pointer;
            z-index: 2147483647;
            color: #666;
            width: 36px;
            height: 36px;
            border-radius: 50%;
            display: flex;
            align-items: center;
            justify-content: center;
            transition: all 0.3s cubic-bezier(0.4, 0, 0.2, 1);
            box-shadow: 0 2px 8px rgba(0,0,0,0.1);
            position: relative;
            overflow: hidden;
        `;
        closeButton.addEventListener('mouseenter', () => {
            closeButton.style.background = '#f5f5f5';
            closeButton.style.color = '#333';
            closeButton.style.transform = 'scale(1.1)';
        });
        closeButton.addEventListener('mouseleave', () => {
            closeButton.style.background = 'rgba(255,255,255,0.9)';
            closeButton.style.color = '#666';
            closeButton.style.transform = 'scale(1)';
        });
        closeButton.addEventListener('click', (e) => {
            // 添加波纹效果
            createRipple(e, closeButton);
            // 延迟移除以便看到动画
            setTimeout(() => overlay.remove(), 300);
        }, { passive: true });

        // 创建复制按钮
        const copyButton = document.createElement('button');
        copyButton.innerHTML = '📋 复制Markdown';
        copyButton.style.cssText = `
            position: absolute;
            top: 20px;
            left: 20px;
            font-size: 14px;
            border: 1px solid #1976D2;
            background: linear-gradient(135deg, #ffffff, #e3f2fd);
            cursor: pointer;
            color: #1976D2;
            display: flex;
            align-items: center;
            gap: 6px;
            padding: 8px 16px;
            border-radius: 20px;
            transition: all 0.3s cubic-bezier(0.4, 0, 0.2, 1);
            font-weight: 500;
            box-shadow: 0 2px 8px rgba(25, 118, 210, 0.1);
            position: relative;
            overflow: hidden;
        `;
        copyButton.setAttribute('title', '复制Markdown格式内容到剪贴板');

        copyButton.addEventListener('click', async (e) => {
            // 添加波纹效果
            createRipple(e, copyButton);

            if (!currentClassID) {
                showNotification('未检测到有效的classID', 'error');
                return;
            }

            let markdown = '';
            storedQuestions.forEach((q, index) => {
                markdown += `\n\n---\n\n### ${index + 1}. ${q.title}\n`;

                const options = answerCache.get(q.id) || [];
                const letters = ['A', 'B', 'C', 'D', 'E', 'F'];
                let correctAnswers = [];

                options.forEach((opt, idx) => {
                    markdown += `${letters[idx] || (idx + 1)}. ${opt.content}\n`;
                    if (opt.isCorrect) correctAnswers.push(letters[idx] || (idx + 1));
                });

                markdown += `\n**答案：** ${correctAnswers.join('、')}\n\n---`;
            });

            markdown = markdown.trim() + '\n';

            try {
                await navigator.clipboard.writeText(markdown);
                copyButton.innerHTML = '<span>✓</span> 已复制';
                copyButton.style.color = '#4CAF50';
                copyButton.style.borderColor = '#4CAF50';
                showNotification('✅ Markdown已复制到剪贴板', 'success');
                setTimeout(() => {
                    copyButton.innerHTML = '📋 复制Markdown';
                    copyButton.style.color = '#1976D2';
                    copyButton.style.borderColor = '#1976D2';
                }, 2000);
            } catch (err) {
                console.error('复制失败:', err);
                copyButton.innerHTML = '<span>✗</span> 复制失败';
                copyButton.style.color = '#F44336';
                copyButton.style.borderColor = '#F44336';
                showNotification('复制失败，请手动复制', 'error');
                setTimeout(() => {
                    copyButton.innerHTML = '📋 复制Markdown';
                    copyButton.style.color = '#1976D2';
                    copyButton.style.borderColor = '#1976D2';
                }, 2000);
            }
        }, { passive: true });

        // 添加自动遍历答案按钮
        const autoBrowseButton = document.createElement('button');
        autoBrowseButton.innerHTML = '🤖 自动遍历答案';
        autoBrowseButton.style.cssText = `
            position: absolute;
            top: 20px;
            left: 160px;
            font-size: 14px;
            border: 1px solid #4CAF50;
            background: linear-gradient(135deg, #ffffff, #e8f5e8);
            cursor: pointer;
            color: #4CAF50;
            display: flex;
            align-items: center;
            gap: 6px;
            padding: 8px 16px;
            border-radius: 20px;
            transition: all 0.3s cubic-bezier(0.4, 0, 0.2, 1);
            font-weight: 500;
            box-shadow: 0 2px 8px rgba(76, 175, 80, 0.1);
            position: relative;
            overflow: hidden;
        `;
        autoBrowseButton.setAttribute('title', '自动点击每个题目的"查看"按钮，提取答案并关闭窗口');
        autoBrowseButton.addEventListener('click', (e) => {
            // 添加波纹效果
            createRipple(e, autoBrowseButton);
            // 延迟打开速度设置对话框以便看到动画
            setTimeout(() => showSpeedSettingsDialog(), 300);
        }, { passive: true });

        // 添加手动刷新按钮
        const manualRefreshButton = document.createElement('button');
        manualRefreshButton.innerHTML = '🔄 刷新内容';
        manualRefreshButton.style.cssText = `
            position: absolute;
            top: 20px;
            left: 300px;
            font-size: 14px;
            border: 1px solid #FF9800;
            background: linear-gradient(135deg, #ffffff, #fff3e0);
            cursor: pointer;
            color: #FF9800;
            display: flex;
            align-items: center;
            gap: 6px;
            padding: 8px 16px;
            border-radius: 20px;
            transition: all 0.3s cubic-bezier(0.4, 0, 0.2, 1);
            font-weight: 500;
            box-shadow: 0 2px 8px rgba(255, 152, 0, 0.1);
            position: relative;
            overflow: hidden;
        `;
        manualRefreshButton.setAttribute('title', '手动刷新题目和答案内容');
        manualRefreshButton.addEventListener('click', (e) => {
            // 添加波纹效果
            createRipple(e, manualRefreshButton);

            manualRefreshButton.innerHTML = '⏳ 刷新中...';
            manualRefreshButton.style.color = '#FFA726';
            manualRefreshButton.style.borderColor = '#FFA726';

            // 执行刷新
            refreshUIAfterTraversal();

            // 恢复按钮状态
            setTimeout(() => {
                manualRefreshButton.innerHTML = '🔄 刷新内容';
                manualRefreshButton.style.color = '#FF9800';
                manualRefreshButton.style.borderColor = '#FF9800';
            }, 2000);
        }, { passive: true });

        container.appendChild(autoBrowseButton);
        container.appendChild(manualRefreshButton);
        container.appendChild(closeButton);
        container.appendChild(copyButton);

        const list = document.createElement('div');
        list.id = 'questions-list';
        list.style.padding = '32px';
        list.style.paddingTop = '80px';

        storedQuestions.forEach((q, index) => {
            const questionBlock = document.createElement('div');
            questionBlock.className = 'question-block';
            questionBlock.style.marginBottom = '24px';
            questionBlock.style.animationDelay = `${index * 0.1}s`;

            const title = document.createElement('h3');
            title.textContent = `${index + 1}. ${q.title}`;
            title.style.cssText = `
                color: #1976D2;
                margin: 0 0 16px 0;
                font-size: 18px;
                font-weight: 600;
                line-height: 1.4;
            `;

            const optionsContainer = document.createElement('div');
            optionsContainer.style.marginLeft = '0px';

            const answerContainer = document.createElement('div');
            answerContainer.style.marginTop = '16px';
            answerContainer.style.paddingLeft = '0px';
            answerContainer.style.fontSize = '15px';
            answerContainer.style.fontWeight = '600';

            const loadAnswer = async () => {
                if (answerCache.has(q.id)) {
                    renderContent(answerCache.get(q.id));
                    return;
                }

                try {
                    const apiUrl = `/evaluation/api/TeacherEvaluation/GetQuestionAnswerListByQID?classID=${currentClassID}&questionID=${q.id}`;
                    const response = await fetch(apiUrl);
                    const data = await response.json();

                    if (data.success) {
                        const options = data.data.map(opt => ({
                            content: opt.oppentionContent
                                .replace(/<[^>]+>/g, '')
                                .replace(/&nbsp;/g, ' ')
                                .trim(),
                            isCorrect: opt.isTrue
                        }));
                        answerCache.set(q.id, options);
                        renderContent(options);
                    }
                } catch (e) {
                    console.error('选项加载失败:', e);
                    optionsContainer.innerHTML = '<div style="color: red">加载失败</div>';
                }
            };

            // 创建波纹效果函数
            function createRipple(event, element) {
                // 创建波纹元素
                const ripple = document.createElement('span');
                ripple.className = 'ripple';

                // 计算波纹位置和大小
                const rect = element.getBoundingClientRect();
                const size = Math.max(rect.width, rect.height);
                const x = event.clientX - rect.left - size / 2;
                const y = event.clientY - rect.top - size / 2;

                // 设置波纹样式
                ripple.style.width = ripple.style.height = size + 'px';
                ripple.style.left = x + 'px';
                ripple.style.top = y + 'px';

                // 添加波纹并在动画结束后移除
                element.appendChild(ripple);
                setTimeout(() => ripple.remove(), 600);
            }

            const renderContent = (options) => {
                optionsContainer.innerHTML = '';
                answerContainer.innerHTML = '';

                const letters = ['A', 'B', 'C', 'D', 'E', 'F'];
                let correctAnswers = [];

                options.forEach((opt, idx) => {
                    const optionDiv = document.createElement('div');
                    optionDiv.className = 'option-item';
                    if (opt.isCorrect) {
                        optionDiv.classList.add('correct');
                        correctAnswers.push(letters[idx] || String(idx + 1));
                    }

                    const letter = letters[idx] || String(idx + 1);
                    const mark = document.createElement('span');
                    mark.textContent = `${letter}. `;
                    mark.style.fontWeight = '600';
                    mark.style.color = opt.isCorrect ? '#2E7D32' : '#666';

                    const content = document.createTextNode(opt.content);
                    optionDiv.appendChild(mark);
                    optionDiv.appendChild(content);

                    optionsContainer.appendChild(optionDiv);
                });

                // 创建答案标签
                const answerBadge = document.createElement('span');
                answerBadge.className = correctAnswers.length > 1 ? 'answer-badge multiple' : 'answer-badge single';
                answerBadge.textContent = `答案：${correctAnswers.join('、')}`;

                // 添加交互效果
                answerBadge.style.cursor = 'pointer';
                answerBadge.addEventListener('mouseenter', () => {
                    answerBadge.style.transform = 'scale(1.05)';
                    answerBadge.style.boxShadow = '0 4px 16px rgba(0, 0, 0, 0.15)';
                    answerBadge.style.transition = 'all 0.3s cubic-bezier(0.4, 0, 0.2, 1)';
                });
                answerBadge.addEventListener('mouseleave', () => {
                    answerBadge.style.transform = 'scale(1)';
                    answerBadge.style.boxShadow = 'none';
                });

                // 点击时复制答案
                answerBadge.addEventListener('click', () => {
                    navigator.clipboard.writeText(correctAnswers.join('、')).then(() => {
                        const originalText = answerBadge.textContent;
                        answerBadge.textContent = '已复制！';
                        answerBadge.style.background = '#4CAF50';
                        setTimeout(() => {
                            answerBadge.textContent = originalText;
                            answerBadge.style.background = '';
                        }, 1500);
                    });
                });

                answerContainer.appendChild(answerBadge);
            };

            loadAnswer();
            questionBlock.appendChild(title);
            questionBlock.appendChild(optionsContainer);
            questionBlock.appendChild(answerContainer);
            list.appendChild(questionBlock);
        });

        container.appendChild(list);
        overlay.appendChild(container);
        document.body.appendChild(overlay);
    }

    // ========== 自动遍历答案功能 ==========
    function autoBrowseAnswers() {
        // 防止重复处理
        if (isProcessingExtraction) {
            alert('正在处理中，请稍候...');
            return;
        }

        const viewButtons = document.querySelectorAll('a[style="color: rgb(64, 158, 255);"]');

        if (viewButtons.length === 0) {
            alert('未找到题目查看按钮');
            return;
        }

        // 初始化处理状态
        isProcessingExtraction = true;
        processingQueue = Array.from(viewButtons);
        currentProcessingIndex = 0;

        // 显示进度提示
        const progressDiv = document.createElement('div');
        progressDiv.style.cssText = `
            position: fixed;
            top: 50%;
            left: 50%;
            transform: translate(-50%, -50%);
            background: rgba(0, 0, 0, 0.8);
            color: white;
            padding: 20px;
            border-radius: 10px;
            z-index: 2147483647;
            font-size: 18px;
            text-align: center;
        `;
        progressDiv.textContent = `正在处理题目: 0/${processingQueue.length}`;
        document.body.appendChild(progressDiv);

        // 使用非递归方式处理队列
        processQueueWithDelay(progressDiv);
    }

    // 使用非递归方式处理队列，避免堆栈溢出
    function processQueueWithDelay(progressDiv) {
        const processNext = () => {
            if (currentProcessingIndex >= processingQueue.length) {
                // 处理完成
                isProcessingExtraction = false;
                progressDiv.remove();
                alert(`已完成所有 ${processingQueue.length} 个题目的遍历`);

                // 遍历完成后刷新UI并加载新内容
                setTimeout(() => {
                    refreshUIAfterTraversal();
                }, 1000); // 延迟1秒后刷新UI，确保所有数据已加载

                return;
            }

            const button = processingQueue[currentProcessingIndex];
            currentProcessingIndex++;

            // 更新进度
            progressDiv.textContent = `正在处理题目: ${currentProcessingIndex}/${processingQueue.length}`;

            // 处理当前题目
            processSingleQuestion(button)
                .then(() => {
                    // 使用requestAnimationFrame代替setTimeout，提高性能
                    requestAnimationFrame(processNext);
                })
                .catch(error => {
                    console.error('处理题目时出错:', error);
                    // 即使出错也继续处理下一个
                    requestAnimationFrame(processNext);
                });
        };

        // 开始处理
        requestAnimationFrame(processNext);
    }

    // 处理单个题目
    async function processSingleQuestion(button) {
        try {
            // 点击"查看"按钮
            button.click();

            // 等待弹窗出现
            const modal = await waitForElement('.el-dialog[aria-label="试题详情"]', 3000);

            // 等待内容加载 - 使用用户设置的速度
            await new Promise(resolve => setTimeout(resolve, traverseSpeed));

            // 提取答案信息
            extractAnswerInfo(modal);

            // 尝试关闭弹窗 - 使用更可靠的方法
            await closeDialogImproved(modal);

        } catch (error) {
            console.error('处理单个题目时出错:', error);
            // 不抛出错误，继续处理下一个
        }
    }

    // 彻底改进的弹窗关闭函数
    async function closeDialogImproved(modal) {
        return new Promise((resolve) => {
            // 查找关闭按钮
            const closeButton = modal.querySelector('.el-dialog__headerbtn');

            if (closeButton) {
                // 点击关闭按钮
                closeButton.click();

                // 立即检查弹窗是否已经关闭
                const immediateCheck = () => {
                    if (!document.body.contains(modal)) {
                        resolve();
                        return;
                    }

                    // 如果立即检查没有关闭，使用多种方法继续检查
                    let checkCount = 0;
                    const maxChecks = 10; // 减少检查次数
                    const checkInterval = 50; // 减少检查间隔

                    const checkClosed = () => {
                        checkCount++;

                        // 方法1：检查元素是否还在DOM中
                        if (!document.body.contains(modal)) {
                            resolve();
                            return;
                        }

                        // 方法2：检查弹窗是否隐藏
                        if (modal.style.display === 'none' ||
                            modal.classList.contains('el-dialog__wrapper--hidden') ||
                            window.getComputedStyle(modal).display === 'none') {
                            resolve();
                            return;
                        }

                        // 方法3：检查弹窗的v-show属性
                        if (modal.getAttribute('aria-hidden') === 'true') {
                            resolve();
                            return;
                        }

                        // 方法4：检查弹窗的可见性
                        if (modal.offsetParent === null) {
                            resolve();
                            return;
                        }

                        // 如果达到最大检查次数，强制继续
                        if (checkCount >= maxChecks) {
                            console.warn('弹窗关闭检测超时，强制继续');
                            // 尝试强制关闭
                            try {
                                // 尝试通过ESC键关闭
                                const escEvent = new KeyboardEvent('keydown', {
                                    key: 'Escape',
                                    code: 'Escape',
                                    keyCode: 27,
                                    which: 27,
                                    bubbles: true,
                                    cancelable: true
                                });
                                document.dispatchEvent(escEvent);

                                // 再次检查
                                setTimeout(() => {
                                    if (!document.body.contains(modal)) {
                                        resolve();
                                    } else {
                                        // 最后的强制方法：直接移除DOM元素
                                        if (modal.parentNode) {
                                            modal.parentNode.removeChild(modal);
                                        }
                                        resolve();
                                    }
                                }, 50);
                            } catch (e) {
                                console.error('强制关闭弹窗失败:', e);
                                resolve();
                            }
                            return;
                        }

                        // 继续检查
                        setTimeout(checkClosed, checkInterval);
                    };

                    // 开始检查
                    setTimeout(checkClosed, 20); // 20ms后开始检查
                };

                // 立即检查
                immediateCheck();
            } else {
                // 如果找不到关闭按钮，直接继续
                resolve();
            }
        });
    }

    // 优化后的辅助函数：等待元素出现
    function waitForElement(selector, timeout = 3000) {
        return new Promise((resolve, reject) => {
            const startTime = Date.now();
            const checkInterval = 50; // 减少检查间隔

            const checkElement = () => {
                const element = document.querySelector(selector);
                if (element) {
                    resolve(element);
                } else if (Date.now() - startTime > timeout) {
                    reject(new Error(`元素 ${selector} 超时未找到`));
                } else {
                    setTimeout(checkElement, checkInterval);
                }
            };

            checkElement();
        });
    }

    // 提取答案信息的函数
    function extractAnswerInfo(modal) {
        const questionTitle = modal.querySelector('.questionTitle');
        const answerElements = modal.querySelectorAll('.questionAnswer');

        if (!questionTitle || answerElements.length === 0) {
            return;
        }

        const questionText = questionTitle.textContent.trim();

        // 收集答案信息
        const answers = [];
        answerElements.forEach(answerEl => {
            const letter = answerEl.querySelector('.answerTitle > div')?.textContent?.trim();
            const content = answerEl.querySelector('.answerTitle > div:last-child')?.textContent?.trim();
            const isCorrect = answerEl.querySelector('.answersuccess') !== null;

            if (letter && content) {
                answers.push({
                    letter,
                    content,
                    isCorrect
                });
            }
        });

        // 从题目文本中提取题号
        const questionNumberMatch = questionText.match(/第(\d+)题/);
        let questionNumber = null;
        if (questionNumberMatch) {
            questionNumber = parseInt(questionNumberMatch[1]);
        }

        // 提取答案
        const correctAnswers = answers.filter(a => a.isCorrect).map(a => a.letter);
        console.log(`第${questionNumber || '未知'}题: ${questionText}`);
        console.log(`答案: ${correctAnswers.join(', ')}`);

        // 尝试将答案添加到answerCache
        if (questionNumber && questionNumber <= storedQuestions.length) {
            const questionId = storedQuestions[questionNumber - 1].id;
            if (questionId) {
                const options = answers.map(a => ({
                    content: a.content,
                    isCorrect: a.isCorrect
                }));
                answerCache.set(questionId, options);
            }
        }
    }

    // ========== 遍历完成后刷新UI ==========
    function refreshUIAfterTraversal() {
        console.log('开始刷新UI和加载新内容...');

        // 1. 重新触发API请求获取最新数据
        console.log('重新触发数据加载...');

        // 尝试重新触发页面数据加载
        const refreshButton = document.querySelector('[class*="refresh"], [class*="reload"], button[title*="刷新"]');
        if (refreshButton) {
            console.log('点击刷新按钮重新加载数据...');
            refreshButton.click();
            // 显示加载中通知
            showNotification('正在刷新数据...', 'info');
        } else {
            // 如果没有刷新按钮，尝试重新触发当前页面的数据请求
            console.log('尝试重新触发数据请求...');
            // 显示加载中通知
            showNotification('正在刷新数据...', 'info');
            // 触发页面重新加载数据（通过重新触发当前路由或重新发送请求）
            setTimeout(() => {
                // 重新触发fetch请求
                if (currentClassID) {
                    const url = `/api/Knowledge/GetKnowQuestionEvaluation?classID=${currentClassID}`;
                    fetch(url)
                        .then(response => response.json())
                        .then(data => {
                            console.log('重新获取数据成功:', data);
                            // 数据会通过interceptFetch自动处理
                            // 显示成功通知
                            showNotification('数据刷新成功！', 'success');
                        })
                        .catch(error => {
                            console.error('重新获取数据失败:', error);
                            // 显示错误通知
                            showNotification('数据刷新失败，请重试', 'error');
                        });
                }
            }, 500);
        }

        // 2. 更新主按钮状态
        const toggleButton = document.querySelector('button[title="显示题目"]');
        if (toggleButton) {
            updateToggleButton(toggleButton);
        }

        // 3. 如果面板是打开的，刷新面板内容
        const existingOverlay = document.querySelector('#question-overlay');
        if (existingOverlay) {
            // 获取当前滚动位置
            const listElement = existingOverlay.querySelector('#questions-list');
            const scrollPosition = listElement?.scrollTop || 0;

            // 关闭现有面板
            existingOverlay.remove();

            // 重新创建面板
            setTimeout(() => {
                createQuestionPanel();

                // 恢复滚动位置
                const newListElement = document.querySelector('#questions-list');
                if (newListElement) {
                    newListElement.scrollTop = scrollPosition;
                }
            }, 1500); // 增加延迟，确保数据加载完成
        }

        console.log('UI刷新完成');
        showCompletionNotification();
    }

    // ========== 统一通知函数 ==========
    function showNotification(message, type = 'success', duration = 3000) {
        // 类型样式配置
        const typeConfig = {
            success: {
                background: 'linear-gradient(135deg, #00C853, #66BB6A)',
                color: 'white',
                icon: '✅',
                boxShadow: '0 8px 24px rgba(0, 200, 83, 0.3)'
            },
            error: {
                background: 'linear-gradient(135deg, #F44336, #EF5350)',
                color: 'white',
                icon: '❌',
                boxShadow: '0 8px 24px rgba(244, 67, 54, 0.3)'
            },
            info: {
                background: 'linear-gradient(135deg, #2196F3, #64B5F6)',
                color: 'white',
                icon: 'ℹ️',
                boxShadow: '0 8px 24px rgba(33, 150, 243, 0.3)'
            },
            warning: {
                background: 'linear-gradient(135deg, #FF9800, #FFB74D)',
                color: 'white',
                icon: '⚠️',
                boxShadow: '0 8px 24px rgba(255, 152, 0, 0.3)'
            }
        };

        const config = typeConfig[type] || typeConfig.success;

        // 移除旧的通知样式（如果存在）
        const oldStyle = document.getElementById('zx-notification-style');
        if (oldStyle) oldStyle.remove();

        // 添加通知样式
        const notificationStyle = document.createElement('style');
        notificationStyle.id = 'zx-notification-style';
        notificationStyle.textContent = `
            @keyframes zxSlideInRight {
                from { transform: translateX(100%); opacity: 0; }
                to { transform: translateX(0); opacity: 1; }
            }
            @keyframes zxSlideOutRight {
                from { transform: translateX(0); opacity: 1; }
                to { transform: translateX(100%); opacity: 0; }
            }
            @keyframes zxSlideInTop {
                from { transform: translateY(-100%); opacity: 0; }
                to { transform: translateY(0); opacity: 1; }
            }
            @keyframes zxSlideOutTop {
                from { transform: translateY(0); opacity: 1; }
                to { transform: translateY(-100%); opacity: 0; }
            }
        `;
        document.head.appendChild(notificationStyle);

        // 创建通知元素
        const notification = document.createElement('div');
        notification.className = 'zx-notification';
        notification.style.cssText = `
            position: fixed;
            top: 20px;
            right: 20px;
            background: ${config.background};
            color: ${config.color};
            padding: 16px 24px;
            border-radius: 12px;
            box-shadow: ${config.boxShadow};
            z-index: 2147483647;
            font-size: 14px;
            font-weight: 600;
            animation: zxSlideInRight 0.5s ease-out;
            backdrop-filter: blur(10px);
            border: 1px solid rgba(255,255,255,0.2);
            display: flex;
            align-items: center;
            gap: 10px;
            max-width: 350px;
            word-break: break-word;
        `;
        notification.innerHTML = `<span>${config.icon}</span><span>${message}</span>`;

        // 添加关闭按钮
        const closeBtn = document.createElement('span');
        closeBtn.innerHTML = '×';
        closeBtn.style.cssText = `
            position: absolute;
            top: 8px;
            right: 12px;
            cursor: pointer;
            font-size: 16px;
            opacity: 0.8;
            transition: opacity 0.2s, transform 0.2s;
        `;
        closeBtn.addEventListener('mouseenter', () => {
            closeBtn.style.opacity = '1';
            closeBtn.style.transform = 'scale(1.1)';
        });
        closeBtn.addEventListener('mouseleave', () => {
            closeBtn.style.opacity = '0.8';
            closeBtn.style.transform = 'scale(1)';
        });
        closeBtn.addEventListener('click', () => {
            removeNotification();
        });
        notification.appendChild(closeBtn);

        document.body.appendChild(notification);

        // 自动移除函数
        function removeNotification() {
            notification.style.animation = 'zxSlideOutRight 0.5s ease-out';
            setTimeout(() => {
                if (notification.parentNode) {
                    notification.parentNode.removeChild(notification);
                }
                if (notificationStyle.parentNode) {
                    notificationStyle.parentNode.removeChild(notificationStyle);
                }
            }, 500);
        }

        // 自动关闭计时器
        setTimeout(removeNotification, duration);

        return notification;
    }

    // ========== 创建题目显示按钮 ==========
    function createToggleButton() {
        // 检查是否已存在按钮
        if (document.getElementById('question-toggle-btn')) {
            return document.getElementById('question-toggle-btn');
        }

        // 添加按钮样式
        const style = document.createElement('style');
        style.textContent = `
            #question-toggle-btn {
                position: fixed;
                bottom: 30px;
                right: 30px;
                z-index: 2147483646;
                padding: 16px 24px;
                background: linear-gradient(135deg, #4CAF50, #66BB6A);
                color: white;
                border: none;
                border-radius: 50px;
                cursor: pointer;
                transition: all 0.3s cubic-bezier(0.4, 0, 0.2, 1);
                font-size: 14px;
                font-weight: 600;
                box-shadow: 0 8px 24px rgba(76, 175, 80, 0.3);
                backdrop-filter: blur(10px);
                border: 1px solid rgba(255,255,255,0.2);
                display: none; /* 默认隐藏，只在需要时显示 */
                font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif;
                position: relative;
                overflow: hidden;
            }

            #question-toggle-btn:hover {
                transform: translateY(-2px) scale(1.05);
                box-shadow: 0 12px 32px rgba(76, 175, 80, 0.4);
                background: linear-gradient(135deg, #66BB6A, #81C784);
            }

            #question-toggle-btn:active {
                transform: translateY(0) scale(0.98);
                box-shadow: 0 4px 16px rgba(76, 175, 80, 0.3);
            }

            #question-toggle-btn .ripple {
                position: absolute;
                border-radius: 50%;
                background: rgba(255, 255, 255, 0.5);
                transform: scale(0);
                animation: zxRipple 0.6s ease-out;
                pointer-events: none;
            }

            @keyframes zxRipple {
                to {
                    transform: scale(4);
                    opacity: 0;
                }
            }

            #question-toggle-btn.badge {
                position: relative;
            }

            #question-toggle-btn .badge-count {
                position: absolute;
                top: -8px;
                right: -8px;
                background: #F44336;
                color: white;
                border-radius: 50%;
                min-width: 24px;
                height: 24px;
                font-size: 12px;
                font-weight: bold;
                display: flex;
                align-items: center;
                justify-content: center;
                box-shadow: 0 2px 8px rgba(244, 67, 54, 0.3);
                animation: zxBadgePulse 1s infinite;
            }

            @keyframes zxBadgePulse {
                0% {
                    transform: scale(1);
                }
                50% {
                    transform: scale(1.1);
                }
                100% {
                    transform: scale(1);
                }
            }
        `;
        document.head.appendChild(style);

        const button = document.createElement('button');
        button.id = 'question-toggle-btn';
        button.textContent = '显示题目 (0/0)';
        button.setAttribute('title', '显示题目列表');

        // 添加点击波纹效果
        button.addEventListener('click', (e) => {
            // 创建波纹元素
            const ripple = document.createElement('span');
            ripple.className = 'ripple';

            // 计算波纹位置和大小
            const rect = button.getBoundingClientRect();
            const size = Math.max(rect.width, rect.height);
            const x = e.clientX - rect.left - size / 2;
            const y = e.clientY - rect.top - size / 2;

            // 设置波纹样式
            ripple.style.width = ripple.style.height = size + 'px';
            ripple.style.left = x + 'px';
            ripple.style.top = y + 'px';

            // 添加波纹并在动画结束后移除
            button.appendChild(ripple);
            setTimeout(() => ripple.remove(), 600);

            // 原有点击逻辑
            if (storedQuestions.length > 0) {
                createQuestionPanel();
            } else {
                showNotification('请先触发题目加载', 'warning');
            }
        }, { passive: true });

        document.body.appendChild(button);
        return button;
    }

    function updateToggleButton(button) {
        if (!button) return;

        // 获取当前活动的标签页
        const activeTab = document.querySelector('.tab-btn.active')?.getAttribute('data-tab');

        // 根据当前标签页显示不同的按钮状态
        if (activeTab === 'extract') {
            // 在答案提取界面时，显示"显示题目 (0/10)"
            const validQuestionIds = new Set(storedQuestions.map(q => q.id));
            const filteredCache = Array.from(answerCache.entries()).filter(
                ([qid]) => validQuestionIds.has(qid)
            );

            const total = storedQuestions.length;
            const completed = filteredCache.reduce((count, [qid, opts]) => {
                return count + (opts.length > 0 ? 1 : 0);
            }, 0);

            if (total > 0) {
                // 设置文本内容
                button.innerHTML = `显示题目 <span class="badge-count">${completed}/${total}</span>`;
                button.style.display = 'block';

                // 添加徽章样式（如果不存在）
                const badgeStyle = document.getElementById('zx-badge-style');
                if (!badgeStyle) {
                    const style = document.createElement('style');
                    style.id = 'zx-badge-style';
                    style.textContent = `
                        .badge-count {
                            display: inline-flex;
                            align-items: center;
                            justify-content: center;
                            background: rgba(255, 255, 255, 0.3);
                            color: white;
                            padding: 2px 8px;
                            border-radius: 12px;
                            font-size: 12px;
                            font-weight: bold;
                            margin-left: 6px;
                            transition: all 0.3s ease;
                        }
                        .badge-animation {
                            animation: zxBounce 0.6s cubic-bezier(0.175, 0.885, 0.32, 1.275);
                        }
                        @keyframes zxBounce {
                            0%, 100% { transform: scale(1); }
                            50% { transform: scale(1.2); }
                        }
                    `;
                    document.head.appendChild(style);
                }

                // 添加徽章动画效果（当完成数量变化时）
                const badge = button.querySelector('.badge-count');
                if (badge) {
                    badge.classList.add('badge-animation');
                    setTimeout(() => badge.classList.remove('badge-animation'), 600);
                }

                if (completed === total) {
                    button.style.background = 'linear-gradient(135deg, #00C853, #66BB6A)';
                    button.style.boxShadow = '0 8px 24px rgba(0, 200, 83, 0.3)';
                } else if (completed > 0) {
                    button.style.background = 'linear-gradient(135deg, #FFA726, #FFB74D)';
                    button.style.boxShadow = '0 8px 24px rgba(255, 167, 38, 0.3)';
                } else {
                    button.style.background = 'linear-gradient(135deg, #4CAF50, #66BB6A)';
                    button.style.boxShadow = '0 8px 24px rgba(76, 175, 80, 0.3)';
                }
            } else {
                button.style.display = 'none';
            }
        } else {
            // 在答题界面时，隐藏按钮
            button.style.display = 'none';
        }
    }

    // ========== 拦截网络请求 ==========
    function interceptFetch(toggleButton) {
        const originalFetch = window.fetch;
        window.fetch = async (...args) => {
            try {
                const response = await originalFetch.apply(this, args);
                handleResponse(await response.clone().json(), args[0], toggleButton);
                return response;
            } catch (e) {
                console.error('Fetch请求失败:', e);
                throw e;
            }
        };
    }

    function interceptXHR(toggleButton) {
        const originalOpen = XMLHttpRequest.prototype.open;
        const originalSend = XMLHttpRequest.prototype.send;

        XMLHttpRequest.prototype.open = function (...args) {
            this._url = args[1];
            return originalOpen.apply(this, args);
        };

        XMLHttpRequest.prototype.send = function (...args) {
            this.addEventListener('load', () => {
                try {
                    if (this.readyState === 4 && this.status === 200) {
                        const contentType = this.getResponseHeader('Content-Type');
                        if (contentType && contentType.includes('application/json')) {
                            const response = JSON.parse(this.responseText);
                            handleResponse(response, this._url, toggleButton);
                        }
                    }
                } catch (e) {
                    console.error('XHR处理异常:', e);
                }
            }, { passive: true });

            return originalSend.apply(this, args);
        };
    }

    function handleResponse(response, url, toggleButton) {
        try {
            const fullUrl = new URL(url, window.location.origin);

            if (fullUrl.pathname.endsWith('GetKnowQuestionEvaluation')) {
                console.groupCollapsed('%c题目列表API', 'color: #2196F3');
                currentClassID = fullUrl.searchParams.get('classID');

                if (response.success && Array.isArray(response.data)) {
                    const newQuestionIds = new Set(response.data.map(q => q.QuestionID));

                    for (const qid of answerCache.keys()) {
                        if (!newQuestionIds.has(qid)) {
                            answerCache.delete(qid);
                        }
                    }

                    storedQuestions = response.data.map(q => ({
                        id: q.QuestionID,
                        title: q.QuestionTitle
                            .replace(/<[^>]+>/g, '')
                            .replace(/&nbsp;/g, ' ')
                            .trim(),
                    }));
                    console.log('存储的题目数据:', storedQuestions);
                }
                console.groupEnd();
                updateToggleButton(toggleButton);
            }

            if (fullUrl.pathname.endsWith('GetQuestionAnswerListByQID')) {
                console.groupCollapsed('%c答案选项API', 'color: #FF5722');
                if (response.success && Array.isArray(response.data)) {
                    const questionID = fullUrl.searchParams.get('questionID');

                    if (storedQuestions.some(q => q.id === questionID)) {
                        const options = response.data.map(opt => ({
                            content: opt.oppentionContent
                                .replace(/<[^>]+>/g, '')
                                .replace(/&nbsp;/g, ' ')
                                .trim(),
                            isCorrect: opt.isTrue
                        }));
                        answerCache.set(questionID, options);
                        console.log('存储的答案数据:', { questionID, options });
                    }
                }
                console.groupEnd();
                updateToggleButton(toggleButton);
            }
        } catch (e) {
            console.error('处理失败:', e);
        }
    }

    // ========== 初始化 ==========
    function init() {
        // 创建浮动按钮
        createFloatingButton();
        // 默认显示浮动按钮，因为控制面板默认是隐藏的
        const floatingBtn = document.getElementById('floating-toggle-btn');
        if (floatingBtn) {
            floatingBtn.style.display = 'block';
        }

        // 创建统一控制面板
        createUnifiedControlPanel();

        // 默认隐藏控制面板
        const panel = document.getElementById('unified-control-panel');
        if (panel) {
            panel.style.display = 'none';

            // 恢复最小化状态
            const savedMinimizedState = localStorage.getItem('panelMinimized');
            if (savedMinimizedState === 'true') {
                isPanelMinimized = true;
                // 如果面板被显示，应用最小化状态
                const panelContent = panel.querySelector('#panel-content');
                const minimizeBtn = panel.querySelector('#minimize-btn');
                if (panelContent && minimizeBtn) {
                    panelContent.style.display = 'none';
                    minimizeBtn.textContent = '□';
                }
            }
        }

        // 创建题目显示按钮
        const toggleButton = createToggleButton();

        // 初始化按钮状态
        setTimeout(() => {
            updateToggleButton(toggleButton);
        }, 500);

        // 拦截网络请求
        interceptFetch(toggleButton);
        interceptXHR(toggleButton);

        // 添加键盘快捷键支持
        document.addEventListener('keydown', (e) => {
            // ESC键：关闭控制面板
            if (e.key === 'Escape') {
                const panel = document.getElementById('unified-control-panel');
                if (panel && panel.style.display === 'block') {
                    panel.style.animation = 'slideOutDown 0.3s ease-out';
                    setTimeout(() => {
                        panel.style.display = 'none';
                        panel.style.animation = '';
                        // 显示浮动按钮
                        const floatingBtn = document.getElementById('floating-toggle-btn');
                        if (floatingBtn) {
                            floatingBtn.style.display = 'block';
                            floatingBtn.style.animation = 'bounce-in 0.5s ease-out';
                            setTimeout(() => {
                                floatingBtn.style.animation = 'float 4s ease-in-out infinite, pulse 3s ease-in-out infinite';
                            }, 500);
                        }
                    }, 300);
                }
            }

            // Ctrl+Space 或 Alt+T：切换控制面板显示/隐藏
            if ((e.ctrlKey && e.code === 'Space') || (e.altKey && e.key === 't')) {
                e.preventDefault();
                const panel = document.getElementById('unified-control-panel');
                const floatingBtn = document.getElementById('floating-toggle-btn');

                if (panel.style.display === 'block') {
                    // 关闭面板
                    panel.style.animation = 'slideOutDown 0.3s ease-out';
                    setTimeout(() => {
                        panel.style.display = 'none';
                        panel.style.animation = '';
                        // 显示浮动按钮
                        if (floatingBtn) {
                            floatingBtn.style.display = 'block';
                            floatingBtn.style.animation = 'bounce-in 0.5s ease-out';
                            setTimeout(() => {
                                floatingBtn.style.animation = 'float 4s ease-in-out infinite, pulse 3s ease-in-out infinite';
                            }, 500);
                        }
                    }, 300);
                } else {
                    // 显示面板
                    panel.style.display = 'block';
                    panel.style.animation = 'slideInUp 0.3s ease-out';
                    // 隐藏浮动按钮
                    if (floatingBtn) {
                        floatingBtn.style.display = 'none';
                    }
                    setTimeout(() => {
                        panel.style.animation = '';
                    }, 300);
                }
            }

            // Ctrl+M 或 Alt+M：最小化/恢复控制面板
            if ((e.ctrlKey && e.key === 'm') || (e.altKey && e.key === 'm')) {
                e.preventDefault();
                const panel = document.getElementById('unified-control-panel');
                if (panel && panel.style.display === 'block') {
                    const panelContent = panel.querySelector('#panel-content');
                    const minimizeBtn = panel.querySelector('#minimize-btn');

                    if (isPanelMinimized) {
                        // 恢复面板
                        panelContent.style.display = 'flex';
                        panelContent.style.animation = 'fadeIn 0.3s ease-out';
                        minimizeBtn.textContent = '−';
                        panel.style.height = 'auto';
                        panel.style.maxHeight = '80vh';
                        isPanelMinimized = false;

                        // 保存状态到localStorage
                        localStorage.setItem('panelMinimized', 'false');
                    } else {
                        // 最小化面板
                        panelContent.style.animation = 'slideOutDown 0.3s ease-out';
                        setTimeout(() => {
                            panelContent.style.display = 'none';
                        }, 300);
                        minimizeBtn.textContent = '□';
                        panel.style.height = 'auto';
                        isPanelMinimized = true;

                        // 保存状态到localStorage
                        localStorage.setItem('panelMinimized', 'true');
                    }
                }
            }
        });

        // 确保页面完全加载
        if (document.readyState === 'complete' || document.readyState === 'interactive') {
            setTimeout(() => {
                checkStartConfirmation();

                // 确保确认对话框加载完成
                const startModal = document.querySelector('.el-message-box__wrapper');
                if (startModal) {
                    const observer = new MutationObserver(checkStartConfirmation);
                    observer.observe(startModal, { attributes: true });
                }
            }, 2000); // 增加初始延迟，确保页面完全加载
        } else {
            document.addEventListener('DOMContentLoaded', () => {
                setTimeout(() => {
                    checkStartConfirmation();

                    // 确保确认对话框加载完成
                    const startModal = document.querySelector('.el-message-box__wrapper');
                    if (startModal) {
                        const observer = new MutationObserver(checkStartConfirmation);
                        observer.observe(startModal, { attributes: true });
                    }
                }, 1500);
            });
        }
    }

    // 启动脚本
    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', init);
    } else {
        init();
    }
})();
