# 实现用户认证模块

## 背景

当前系统缺少用户认证功能，需要实现基于 JWT 的用户认证模块。

## Tasks

- [ ] 创建 `src/auth/AuthService.ts` 认证服务
- [ ] 实现 JWT token 生成与验证
- [ ] 添加登录/注销 REST API 端点
- [ ] 创建认证中间件 `src/middleware/auth.ts`
- [ ] 编写单元测试 `tests/unit/auth-service.test.ts`
- [ ] 更新 API 文档

## 技术方案

### 认证流程

1. 用户提交用户名密码到 `/api/auth/login`
2. 服务端验证凭证，生成 JWT token
3. 后续请求携带 `Authorization: Bearer <token>` 头
4. 中间件拦截请求并验证 token

### 依赖

- `jsonwebtoken` — JWT 签发与验证
- `bcrypt` — 密码哈希

## 风险

- Token 泄露风险：需设置合理的过期时间（默认 24h）
- 并发场景下的 token 刷新竞态
