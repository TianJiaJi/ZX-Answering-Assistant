// ==UserScript==
// @name         足下教育答题助手（终极性能优化版）
// @namespace    http://tampermonkey.net/
// @version      3.2
// @description  彻底解决性能问题，优化题目检测与答题速度
// @author       You
// @match        https://ai.cqzuxia.com/#/evaluation/knowledge-detail/*
// @grant        GM_setValue
// @grant        GM_getValue
// @run-at       document-idle
// ==/UserScript==

(function () {
  'use strict';

  let KNOWLEDGE_BASE = {};
  let isDragging = false;
  let dragOffsetX = 0, dragOffsetY = 0;
  let observer = null;
  let isProcessing = false;
  let lastQuestionText = '';
  let lastAnswerTime = 0;
  const MIN_TIME_BETWEEN_ANSWERS = 800; // 适当增加间隔时间，避免过快点击

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

  // ========== 创建可拖拽控制面板 ==========
  function createControlPanel() {
    const panel = document.createElement('div');
    panel.id = 'auto-answer-panel';
    panel.style.cssText = `
      position: fixed;
      bottom: 20px;
      right: 20px;
      width: 400px;
      max-height: 80vh;
      background: white;
      border: 1px solid #409eff;
      border-radius: 8px;
      box-shadow: 0 4px 12px rgba(0,0,0,0.3);
      z-index: 2147483647;
      font-family: sans-serif;
      overflow: hidden;
    `;

    panel.innerHTML = `
      <div id="panel-header" style="padding:8px 12px; background:#409eff; color:white; cursor:move; font-weight:bold; display:flex; justify-content:space-between; align-items:center;">
        📚 题库上传与确认
        <span id="close-btn" style="cursor:pointer; font-size:18px;">×</span>
      </div>
      <div style="padding:12px; overflow:auto; max-height:300px;">
        <textarea id="kb-input" placeholder="粘贴题库文本（支持足下教育标准格式）" style="width:100%; height:100px; margin-bottom:8px; padding:6px; border:1px solid #ccc; border-radius:4px; font-family:monospace; font-size:13px;"></textarea>
        <button id="parse-btn" style="width:100%; padding:6px; background:#409eff; color:white; border:none; border-radius:4px; margin-bottom:8px;">✅ 解析题库</button>
        <div id="kb-count" style="margin-bottom:6px; color:#666; font-size:12px;"></div>
        <div id="kb-full-list" style="font-size:12px; max-height:300px; overflow:auto; border:1px solid #eee; padding:6px; border-radius:4px; background:#fafafa;"></div>
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
    panel.querySelector('#close-btn').onclick = () => panel.style.display = 'none';

    // 解析按钮
    panel.querySelector('#parse-btn').onclick = () => {
      const raw = panel.querySelector('#kb-input').value;
      if (!raw.trim()) return;
      KNOWLEDGE_BASE = parseRawText(raw);
      GM_setValue('knowledge_base_raw', raw);
      renderFullList();
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

    // 判断题处理
    if (answerKey === '√' || answerKey === '×') {
      const options = document.querySelectorAll('.an-item .el-radio__label');
      for (const opt of options) {
        const content = opt.querySelector('.option-content')?.textContent || '';
        if ((answerKey === '√' && content.includes('正确')) ||
            (answerKey === '×' && content.includes('错误'))) {
          try {
            // 直接设置选中状态
            const input = opt.closest('.el-radio').querySelector('input[type="radio"]');
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
    // 多选/单选处理
    else {
      const keys = answerKey.split('');
      for (const key of keys) {
        const options = document.querySelectorAll('.an-item .option-answer');
        for (const opt of options) {
          const text = opt.textContent.trim();
          // 匹配选项开头（A. 选项内容 → 匹配 "A"）
          if (text.startsWith(key)) {
            try {
              // 直接设置选中状态
              const input = opt.closest('.el-radio').querySelector('input[type="radio"]');
              if (input && !input.checked) {
                input.click();
                console.log(`✅ 已自动选择选项: ${key}`);
                break; // 选中一个选项后跳出内层循环
              }
            } catch (e) {
              console.error('点击选项失败:', e);
            }
          }
        }
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
        confirmBtn.addEventListener('click', function() {
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

  // ========== 初始化 ==========
  function init() {
    createControlPanel();

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