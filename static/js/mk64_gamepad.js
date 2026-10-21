// Browser Gamepad input translated to the N64 controls expected by the game.
(function (root, factory) {
    const api = factory();
    if (typeof module === 'object' && module.exports) module.exports = api;
    if (root) root.mk64Gamepad = api;
})(typeof window !== 'undefined' ? window : null, function createLayout(layout) {
    'use strict';
    layout ||= {};

    const actions = layout.actions || [
        ['a', 'A', 0x8000], ['b', 'B', 0x4000], ['z', 'Z', 0x2000],
        ['start', 'Start', 0x1000],
        ['dUp', 'D-pad Up', 0x0800], ['dDown', 'D-pad Down', 0x0400],
        ['dLeft', 'D-pad Left', 0x0200], ['dRight', 'D-pad Right', 0x0100],
        ['l', 'L', 0x0020], ['r', 'R', 0x0010],
        ['cUp', 'C Up', 0x0008], ['cDown', 'C Down', 0x0004],
        ['cLeft', 'C Left', 0x0002], ['cRight', 'C Right', 0x0001]
    ];
    const sticks = layout.sticks || [{key: 'stickX', label: 'Move the joystick right'}, {key: 'stickY', label: 'Move the joystick up'}];
    const stepNames = [...actions.map(([key, label]) => ({key, label})),
        ...sticks];

    const clamp = value => Math.max(-1, Math.min(1, Number(value) || 0));
    const rawAxis = value => Number.isFinite(value) ? value : 0;
    const axis = (pad, index) => rawAxis(pad.axes?.[index]);
    const button = (pad, index) => !!(pad.buttons?.[index]?.pressed || pad.buttons?.[index]?.value > 0.5);
    const signature = pad => `${pad.id}|${pad.mapping}|${pad.buttons.length}|${pad.axes.length}`;
    const isN64 = pad => /8bitdo.{0,24}(?:64|n64)|(?:64|n64).{0,24}8bitdo/i.test(pad.id);
    const isStandard = pad => pad.mapping === 'standard' && pad.buttons.length >= 16 && pad.axes.length >= 4;

    function standardProfile() {
        if (layout.standardProfile) return layout.standardProfile();
        const bindings = {
            a: {type: 'button', indices: [0]}, b: {type: 'button', indices: [1]},
            z: {type: 'button', indices: [6]}, start: {type: 'button', indices: [9]},
            dUp: {type: 'button', indices: [12]}, dDown: {type: 'button', indices: [13]},
            dLeft: {type: 'button', indices: [14]}, dRight: {type: 'button', indices: [15]},
            l: {type: 'button', indices: [4]}, r: {type: 'button', indices: [5, 7]},
            cUp: {type: 'axis', index: 3, direction: -1, neutral: 0},
            cDown: {type: 'axis', index: 3, direction: 1, neutral: 0},
            cLeft: {type: 'axis', index: 2, direction: -1, neutral: 0},
            cRight: {type: 'axis', index: 2, direction: 1, neutral: 0}
        };
        return {version: 1, deadzone: 0.18, bindings,
            stickX: {index: 0, direction: 1, neutral: 0},
            stickY: {index: 1, direction: -1, neutral: 0}};
    }

    function emptyProfile() {
        return {version: 1, deadzone: 0.18, bindings: {}, stickX: null, stickY: null};
    }

    function validBinding(binding, pad) {
        if (binding?.type === 'button')
            return Array.isArray(binding.indices) && binding.indices.length > 0 && binding.indices.length <= 2 &&
                binding.indices.every(index => Number.isInteger(index) && index >= 0 && index < pad.buttons.length);
        if (binding?.type === 'axis')
            return Number.isInteger(binding.index) && binding.index >= 0 && binding.index < pad.axes.length &&
                [-1, 1].includes(binding.direction) && Number.isFinite(binding.neutral) && Math.abs(binding.neutral) <= 4 &&
                (binding.target === undefined || (Number.isFinite(binding.target) && Math.abs(binding.target) <= 1));
        return false;
    }

    function restoreProfile(raw, pad, allowIncomplete = false) {
        if (!raw || raw.version !== 1 || typeof raw !== 'object') return null;
        const profile = emptyProfile();
        if (Number.isFinite(raw.deadzone) && raw.deadzone >= 0 && raw.deadzone <= 0.6)
            profile.deadzone = raw.deadzone;
        for (const [key] of actions) if (validBinding(raw.bindings?.[key], pad))
            profile.bindings[key] = raw.bindings[key];
        for (const {key} of sticks) {
            const stick = raw[key];
            if (stick && Number.isInteger(stick.index) && stick.index >= 0 && stick.index < pad.axes.length &&
                [-1, 1].includes(stick.direction) && Number.isFinite(stick.neutral) && Math.abs(stick.neutral) <= 1)
                profile[key] = stick;
        }
        return allowIncomplete || complete(profile) ? profile : null;
    }

    function active(pad, binding) {
        if (!validBinding(binding, pad)) return false;
        if (binding.type === 'button') return binding.indices.some(index => button(pad, index));
        const value = axis(pad, binding.index);
        if (binding.target !== undefined)
            return Math.abs(value - binding.target) <= 0.14 && Math.abs(value - binding.neutral) >= 0.2;
        return (value - binding.neutral) * binding.direction >= 0.55;
    }

    function stickValue(pad, stick, deadzone) {
        if (!stick) return 0;
        const value = clamp((axis(pad, stick.index) - stick.neutral) * stick.direction);
        return Math.abs(value) < deadzone ? 0 : Math.round(value * 80);
    }

    function read(pad, profile) {
        if (!pad?.connected || !profile) return {buttons: 0, x: 0, y: 0};
        let buttons = 0;
        for (const [key, , bit] of actions) if (active(pad, profile.bindings[key])) buttons |= bit;
        return {buttons,
            x: stickValue(pad, profile.stickX, profile.deadzone),
            y: stickValue(pad, profile.stickY, profile.deadzone),
            ...(layout.sticks ? {lookX: stickValue(pad, profile.stickLookX, profile.deadzone),
                lookY: stickValue(pad, profile.stickLookY, profile.deadzone)} : {})};
    }

    function snapshot(pad) {
        return {
            buttons: Array.from(pad.buttons, entry => entry?.pressed ? 1 : Number(entry?.value) || 0),
            axes: Array.from(pad.axes, rawAxis)
        };
    }

    function candidates(pad, baseline, key) {
        const current = snapshot(pad);
        const choices = [];
        current.buttons.forEach((value, index) => {
            if (value >= 0.5 && value - (baseline.buttons[index] || 0) >= 0.5)
                choices.push({type: 'button', indices: [index]});
        });
        current.axes.forEach((value, index) => {
            const neutral = baseline.axes[index] || 0;
            const change = value - neutral;
            // Hat axes can place Left only 2/7 away from their resting value.
            if (Math.abs(change) < (/^[dc]/.test(key) ? 0.2 : 0.45)) return;
            if (key.startsWith('stick'))
                choices.push({type: 'stick', index, direction: Math.sign(change), neutral});
            else
                choices.push({type: 'axis', index, direction: Math.sign(change), neutral,
                    ...(/^[dc]/.test(key) ? {target: value} : {})});
        });
        return choices;
    }

    function complete(profile) {
        return !!(actions.every(([key]) => profile.bindings[key]) && sticks.every(({key}) => profile[key]));
    }

    return {createLayout, layoutName: layout.name, actions, stepNames, signature, isN64, isStandard, standardProfile,
        emptyProfile, restoreProfile, read, snapshot, candidates, complete};
});
