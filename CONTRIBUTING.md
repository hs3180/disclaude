# 贡献指南

感谢您对 disclaude 项目的关注！本文档概述了项目的开发原则和贡献流程。

## 极简风格原则

disclaude 遵循极简主义的设计哲学，核心原则如下：

### 核心功能精简

- **非必须的内容模块不应该包含在主项目中**
  - 好用的 skill 应该作为可选扩展，而非内置
  - 值得推荐的定时任务等功能也应该保持独立
- 保持核心功能的精简和专注
- 避免功能膨胀和不必要的依赖

### 设计理念

1. **专注核心**：只保留最核心、最通用的功能
2. **可扩展性**：通过插件、skill、配置等方式支持扩展
3. **轻量级**：减少依赖，保持项目轻量

## PR 前测试要求

每次提交 PR 之前，请确保通过以下测试：

### 必须通过的检查

```bash
# 1. 构建测试 - 确保项目能够正常构建
npm run build

# 2. 静态检查 - 通过 lint 检查代码质量
npm run lint

# 3. 类型检查 - 确保类型正确
npm run type-check

# 4. 单元测试 - 确保所有单元测试通过
npm run test
```

### 推荐的额外检查

```bash
# 代码格式检查
npm run format:check

# 测试覆盖率
npm run test:coverage
```

### 一键检查

在提交 PR 之前，建议运行完整的检查流程：

```bash
npm run build && npm run lint && npm run type-check && npm run test
```

## 开发流程

1. Fork 本仓库
2. 创建功能分支 (`git checkout -b feature/your-feature`)
3. 进行代码修改
4. 运行测试确保通过
5. 提交更改 (`git commit -m 'Add some feature'`)
6. 推送到分支 (`git push origin feature/your-feature`)
7. 创建 Pull Request

## 代码规范

- 使用 TypeScript 编写代码
- 遵循 ESLint 配置的代码规范
- 为复杂逻辑添加适当的注释
- 保持函数和模块的单一职责

## 更多信息

详细的开发指南请参考 [CLAUDE.md](./CLAUDE.md)，其中包含：

- 项目架构说明
- 常用命令参考
- 开发工作流程
- 常见问题解答
