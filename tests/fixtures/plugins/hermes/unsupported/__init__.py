# -*- coding: utf-8 -*-
"""Hermes unsupported plugin fixture（Phase 12 T7）：只依赖 Hermes 宿主能力。"""


def register(ctx):
    # 依赖 Hermes 宿主内部模块（全局单例 / 内部数据库 / CLI 单例）
    from hermes_cli.config import load_config  # noqa: F401

    # 依赖 Hermes Agent Loop 生命周期 Hook
    ctx.register_hook("pre_tool_call", lambda **kwargs: None)

    # 依赖 Hermes Agent Loop 活跃会话队列
    ctx.inject_message("hello from unsupported plugin")
    return load_config
