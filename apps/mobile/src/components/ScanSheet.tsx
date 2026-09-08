import React, { useEffect, useState } from 'react';
import { Modal, Pressable, StyleSheet, Text, View } from 'react-native';
import { camera, canScan, whyNot } from '../lib/scanner';
import { Button, Muted } from './ui';
import { T } from '../theme';
import { X, ScanLine } from 'lucide-react-native';

/**
 * Point the camera at a code.
 *
 * The whole component is guarded on the native module existing, because
 * expo-camera only ships in a build made after it was added — see lib/scanner.ts
 * for why that has to be a runtime check rather than an import.
 *
 * Deliberately not a screen: scanning is always something you do *to* fill in a
 * field that is already in front of you, and navigating away from that field
 * loses whatever was half-typed in it.
 */
export default function ScanSheet({ open, onClose, onScan, hint }: {
  open: boolean;
  onClose: () => void;
  onScan: (value: string) => void;
  hint?: string;
}) {
  const mod = camera();
  const [granted, setGranted] = useState<boolean | null>(null);
  const [done, setDone] = useState(false);

  useEffect(() => {
    if (!open || !mod) return;
    setDone(false);
    let alive = true;
    mod.Camera.requestCameraPermissionsAsync()
      .then((r) => { if (alive) setGranted(r.granted); })
      .catch(() => { if (alive) setGranted(false); });
    return () => { alive = false; };
  }, [open, mod]);

  if (!open) return null;

  const Body = () => {
    if (!mod) return <Message text={whyNot()} />;
    if (granted === null) return <Message text="Asking for the camera…" />;
    if (granted === false) {
      return (
        <Message text={
          'Munim cannot open the camera. Allow camera access for Munim in your '
          + 'phone settings, then try again — or type the code instead.'} />
      );
    }

    const View3 = mod.CameraView;
    return (
      <View3
        style={StyleSheet.absoluteFill}
        facing="back"
        barcodeScannerSettings={{
          barcodeTypes: ['qr', 'ean13', 'ean8', 'upc_a', 'upc_e', 'code128', 'code39'],
        }}
        /*
         * Fired continuously while a code is in frame, so the first hit wins and
         * everything after it is ignored. Without the latch, one scan closes the
         * sheet and then fires again into a screen that has already moved on.
         */
        onBarcodeScanned={({ data }: { data: string }) => {
          if (done) return;
          setDone(true);
          onScan(data);
        }}
      />
    );
  };

  return (
    <Modal visible={open} animationType="slide" onRequestClose={onClose}>
      <View style={s.wrap}>
        <Body />

        {/* The frame, so somebody knows where to point. */}
        <View pointerEvents="none" style={s.overlay}>
          <View style={s.frame} />
          <Text style={s.hint}>{hint ?? 'Point at the code'}</Text>
        </View>

        <Pressable onPress={onClose} style={s.close} hitSlop={12}>
          <X size={22} strokeWidth={2.4} color="#fff" />
        </Pressable>
      </View>
    </Modal>
  );
}

function Message({ text }: { text: string }) {
  return (
    <View style={s.message}>
      <ScanLine size={28} strokeWidth={1.8} color={T.faint} />
      <Text style={s.messageText}>{text}</Text>
    </View>
  );
}

/** Whether to show a scan button at all. */
export const scanAvailable = canScan;

const s = StyleSheet.create({
  wrap: { flex: 1, backgroundColor: '#000' },
  overlay: { ...StyleSheet.absoluteFillObject, alignItems: 'center',
             justifyContent: 'center', gap: 18 },
  frame: { width: 240, height: 240, borderRadius: 20, borderWidth: 3,
           borderColor: 'rgba(255,255,255,0.85)' },
  hint: { color: '#fff', fontSize: 14, fontWeight: '600',
          textShadowColor: 'rgba(0,0,0,0.6)', textShadowRadius: 6 },
  close: { position: 'absolute', top: 48, right: 20, padding: 8,
           borderRadius: 999, backgroundColor: 'rgba(0,0,0,0.45)' },
  message: { flex: 1, alignItems: 'center', justifyContent: 'center', gap: 14,
             padding: 32, backgroundColor: T.bg },
  messageText: { fontSize: 14, color: T.muted, textAlign: 'center', lineHeight: 21 },
});
