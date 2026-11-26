import { useEffect, useRef, useState } from 'react';
import { AppState, Modal, Platform, ScrollView, Text, TextInput, View } from 'react-native';
import { useChat } from '../contexts/ChatContext';
import { useTheme } from '../contexts/ThemeContext';
import { getColors } from '../theme/colors';
import { space, type } from '../theme/tokens';
import { Button } from './ui';
import { describeMachine, forgetMachine, machineRequest } from '../services/machineAgent/client';

export function MachineAgentLink() {
  const { currentUser } = useChat();
  const [visible, setVisible] = useState(false);
  return (
    <>
      <Button label="Machine agent" size="sm" variant="ghost" onPress={() => setVisible(true)} />
      {visible && currentUser && (
        <MachineSheet key={currentUser.userId} account={currentUser.userId} close={() => setVisible(false)} />
      )}
    </>
  );
}
function MachineSheet({ account, close }: { account: string; close: () => void }) {
  const { scheme } = useTheme();
  const c = getColors(scheme);
  const [device, setDevice] = useState<Awaited<ReturnType<typeof describeMachine>>>();
  const [message, setMessage] = useState('');
  const [offer, setOffer] = useState('');
  const [status, setStatus] = useState('');
  const [busy, setBusy] = useState(false);
  const controller = useRef(new AbortController());
  const mounted = useRef(false);
  const working = useRef(false);
  const textColor = { color: c.textPrimary };
  useEffect(() => {
    mounted.current = true;
    controller.current = new AbortController();
    if (Platform.OS !== 'web')
      describeMachine(account)
        .then((d) => {
          if (mounted.current) setDevice(d);
        })
        .catch(() => {
          if (mounted.current) setStatus('Secure device storage is unavailable.');
        });
    const sub = AppState.addEventListener('change', (state) => {
      if (state !== 'active') close();
    });
    return () => {
      mounted.current = false;
      controller.current.abort();
      sub.remove();
    };
  }, [account]); // Account change remounts the whole sheet, clearing plaintext.
  async function act(action: 'pair' | 'turn' | 'check' | 'forget') {
    if (working.current) return;
    working.current = true;
    setBusy(true);
    setStatus('');
    try {
      if (action === 'forget') {
        await forgetMachine(account);
        if (mounted.current) {
          setOffer('');
          setMessage('');
          setStatus('Device key forgotten. Revoke the grant on your machine.');
        }
      } else {
        const text = await machineRequest(
          account,
          action,
          action === 'pair' ? offer : message,
          controller.current.signal,
        );
        if (mounted.current) {
          setStatus(text);
          setOffer('');
          if (action === 'turn') setMessage('');
        }
      }
    } catch (e) {
      if (mounted.current) setStatus(e instanceof Error ? e.message : 'Machine unavailable.');
    } finally {
      if (mounted.current) {
        try {
          const d = await describeMachine(account);
          if (mounted.current) setDevice(d);
        } catch {
          if (mounted.current) setStatus('Secure device storage is unavailable.');
        }
        if (mounted.current) setBusy(false);
      }
      working.current = false;
    }
  }
  const field = { color: c.textPrimary, borderColor: c.border, borderWidth: 1, padding: space[3] };
  return (
    <Modal visible presentationStyle="pageSheet" onRequestClose={close}>
      <ScrollView
        keyboardShouldPersistTaps="handled"
        style={{ backgroundColor: c.background }}
        contentContainerStyle={{ padding: space[6], gap: space[4] }}
      >
        <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' }}>
          <Text style={[type.heading, textColor]}>Machine agent</Text>
          <Button label="Close" onPress={close} variant="ghost" />
        </View>
        {Platform.OS === 'web' ? (
          <Text style={textColor}>
            Open Machine agent in the installed OpenChat app to pair this device. Machine keys stay in native
            secure storage.
          </Text>
        ) : (
          <>
            {!device?.machine && device && (
              <>
                <Text style={textColor}>Give this public device key to the operator of your machine.</Text>
                <Text selectable style={[type.meta, textColor]}>
                  {device.publicKey}
                </Text>
                <Text style={textColor}>
                  Paste the private offer from that machine. It expires in ten minutes.
                </Text>
                <TextInput
                  value={offer}
                  onChangeText={setOffer}
                  secureTextEntry
                  autoCorrect={false}
                  autoCapitalize="none"
                  maxLength={1500}
                  accessibilityLabel="Private machine offer"
                  style={field}
                />
                <Button
                  label="Pair device"
                  variant="primary"
                  disabled={busy || !offer}
                  onPress={() => void act('pair')}
                />
              </>
            )}
            {device?.machine && (
              <>
                <Text selectable style={[type.meta, textColor]}>
                  Machine public key · {device.machine}
                </Text>
                {!!device.expires && (
                  <Text style={textColor}>Grant expires {new Date(device.expires).toLocaleString()}</Text>
                )}
                {!device.pending && (
                  <>
                    <Text style={textColor}>
                      The machine operator reviews each message. Replies stay in this view.
                    </Text>
                    <TextInput
                      accessibilityLabel="Message to machine agent"
                      multiline
                      maxLength={2000}
                      value={message}
                      onChangeText={setMessage}
                      style={field}
                    />
                    <Button
                      label="Send to machine"
                      variant="primary"
                      disabled={busy || !message.trim()}
                      onPress={() => void act('turn')}
                    />
                  </>
                )}
                {device.last && (
                  <Button
                    label={device.pending ? 'Finish pairing' : 'Check last turn'}
                    disabled={busy}
                    onPress={() => void act('check')}
                  />
                )}
                <Button
                  label="Forget device key"
                  variant="destructive"
                  disabled={busy}
                  onPress={() => void act('forget')}
                />
              </>
            )}
            {busy && (
              <Text accessibilityLiveRegion="polite" style={textColor}>
                Waiting for machine…
              </Text>
            )}
            {!!status && (
              <Text accessibilityLiveRegion="polite" selectable style={textColor}>
                {status}
              </Text>
            )}
          </>
        )}
      </ScrollView>
    </Modal>
  );
}
