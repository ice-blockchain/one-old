"use strict";
// src/adapters/types.ts
// The port: a HostAdapter is the ONLY place that knows a host's raw wire shape.
// It maps a raw hook invocation → canonical HookInput, and a canonical
// HookResult → the host's stdout string. Core + modules never see host shapes.
Object.defineProperty(exports, "__esModule", { value: true });
