// ESLint 9 flat config。仅做静态检查，格式化交给 Prettier（见 .prettierrc），
// 两者通过 eslint-config-prettier 关闭冲突规则。
//
// 这里刻意只开启推荐集 + 少量高风险规则：项目大量使用启发式正则与
// 浏览器上下文字符串（page.evaluate 内的函数在页面里执行，非本进程），
// 过严的规则会产出大量噪声反而掩盖真问题。

import js from '@eslint/js';
import globals from 'globals';
import prettier from 'eslint-config-prettier';

export default [
  {
    ignores: [
      'node_modules/**',
      'dumps/**',
      'logs/**',
      '.browser-profile/**',
      '.browser-profile-chrome/**',
    ],
  },
  js.configs.recommended,
  prettier,
  {
    files: ['**/*.mjs'],
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: 'module',
      globals: {
        // browser 必需：perceive/act 里大量 page.evaluate(...) 的函数体运行在
        // 页面上下文，会出现 window / document / getComputedStyle 等全局。
        // 这些不是本进程的变量，若不声明会被 no-undef 大量误报。
        ...globals.browser,
        ...globals.node,
      },
    },
    rules: {
      // 变量拼写错误 / 死变量是这类脚本最常见的静默故障源
      'no-unused-vars': ['warn', { args: 'none', caughtErrors: 'none' }],
      // 赋值写成判断的笔误
      eqeqeq: ['error', 'always', { null: 'ignore' }],
      // 浏览器容错扫描里有意的空 catch（探测失败即继续下一个候选）
      'no-empty': ['error', { allowEmptyCatch: true }],
      // ai.mjs 在 catch 内改写错误信息后重新抛出，属有意模式
      'no-ex-assign': 'off',
      // 题干清洗会显式扫描图标字体私有区等控制字符区间
      'no-control-regex': 'off',
    },
  },
];
