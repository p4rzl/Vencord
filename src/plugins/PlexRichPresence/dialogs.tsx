/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import type { RenderModalProps } from "@vencord/discord-types";
import { closeModal, Modal, openModal, React, Select, TextInput } from "@webpack/common";

export interface PlexChoice {
    label: string;
    value: string;
}

const pendingDialogs = new Set<string>();

function dialog(render: (props: RenderModalProps, submit: (value: string) => void) => React.ReactNode): Promise<string | null> {
    return new Promise(resolve => {
        const key = openModal(props => render(props, value => {
            resolve(value);
            props.onClose();
        }), {
            onCloseCallback: () => {
                pendingDialogs.delete(key);
                resolve(null);
            }
        });
        pendingDialogs.add(key);
    });
}

export function cancelPlexDialogs() {
    for (const key of pendingDialogs) closeModal(key);
    pendingDialogs.clear();
}

export function choosePlexOption(title: string, choices: PlexChoice[], initialValue: string) {
    return dialog((props, submit) => <ChoiceDialog modalProps={props} title={title} choices={choices} initialValue={initialValue} submit={submit} />);
}

function ChoiceDialog({ modalProps, title, choices, initialValue, submit }: {
    modalProps: RenderModalProps;
    title: string;
    choices: PlexChoice[];
    initialValue: string;
    submit: (value: string) => void;
}) {
    const [value, setValue] = React.useState(choices.some(c => c.value === initialValue) ? initialValue : choices[0]?.value ?? "");
    return <Modal {...modalProps} title={title} size="sm" actions={[
        { text: "Cancel", variant: "secondary", onClick: modalProps.onClose },
        { text: "Select", variant: "primary", disabled: !choices.some(c => c.value === value), onClick: () => submit(value) }
    ]}>
        <Select
            options={choices} placeholder="Select an option" maxVisibleItems={6}
            closeOnSelect select={setValue} isSelected={option => option === value} serialize={option => option}
        />
    </Modal>;
}

export function requestPlexPin(profileName: string) {
    return dialog((props, submit) => <PinDialog modalProps={props} profileName={profileName} submit={submit} />);
}

export function showPlexDiagnostics(data: Record<string, string | number | boolean | null>) {
    const text = JSON.stringify(data, null, 2);
    void dialog(props => <Modal {...props} title="Plex diagnostics" actions={[
        { text: "Close", variant: "secondary", onClick: props.onClose }
    ]}>
        <pre className="prp-diagnostics">{text}</pre>
    </Modal>);
}

function PinDialog({ modalProps, profileName, submit }: {
    modalProps: RenderModalProps;
    profileName: string;
    submit: (value: string) => void;
}) {
    const [pin, setPin] = React.useState("");
    const valid = /^\d{4}$/.test(pin);
    return <Modal {...modalProps} title={`Plex Home PIN · ${profileName}`} size="sm" subtitle="Your PIN is used only for this profile switch and is never saved." actions={[
        { text: "Cancel", variant: "secondary", onClick: modalProps.onClose },
        { text: "Unlock", variant: "primary", disabled: !valid, onClick: () => { if (valid) submit(pin); } }
    ]}>
        <TextInput
            type="password" autoComplete="off" autoFocus maxLength={4} value={pin}
            placeholder="4-digit Plex Home PIN" onChange={setPin}
            onKeyDown={event => { if (event.key === "Enter" && valid) submit(pin); }}
        />
    </Modal>;
}
