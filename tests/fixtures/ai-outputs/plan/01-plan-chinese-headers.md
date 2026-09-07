# 优化数据库查询性能

## 任务

- [ ] 分析慢查询日志，定位 Top 5 慢查询
- [ ] 为 `users` 表的 `email` 字段添加索引
- [ ] 重构 `OrderRepository.findByUser()` 方法，使用连接查询替代 N+1
- [ ] 添加 Redis 缓存层
  - [ ] 实现 `CacheService`
  - [ ] 为热点查询添加缓存
- [ ] 编写性能对比基准测试

## 方案

使用 explain analyze 分析查询计划，针对性优化。
