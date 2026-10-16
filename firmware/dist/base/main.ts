// =============================================================================
//  BASE STATION - MakeCode glue (micro:bit plugged into the PC by USB).
//  Logic lives in qz_base.ts.
// =============================================================================

class BaseHal implements QzBaseHal {
    radioSend(bytes: number[]): void {
        const b = control.createBuffer(bytes.length);
        for (let i = 0; i < bytes.length; i++) b[i] = bytes[i];
        radio.sendBuffer(b);
    }
    serialWrite(text: string): void {
        // writeString, not writeLine: writeLine pads every line to 32 characters.
        serial.writeString(text);
    }
}

radio.setGroup(QZ_GROUP);
radio.setFrequencyBand(QZ_BAND);
radio.setTransmitPower(QZ_TX_POWER);
radio.setTransmitSerialNumber(false);

serial.redirectToUSB();
serial.setRxBufferSize(128);

const qzBase = new QzBase(new BaseHal(), control.millis());

// Radio handler: must be fast (hardware queue holds only 4 packets). It only enqueues.
radio.onReceivedBuffer(function (b: Buffer) {
    const arr: number[] = [];
    for (let i = 0; i < b.length; i++) arr.push(b[i]);
    qzBase.onRadio(arr,
        radio.receivedPacket(RadioPacketProperty.SerialNumber),
        radio.receivedPacket(RadioPacketProperty.SignalStrength),
        control.millis());
});

serial.onDataReceived(serial.delimiters(Delimiters.NewLine), function () {
    qzBase.onSerialLine(serial.readUntil(serial.delimiters(Delimiters.NewLine)), control.millis());
});

basic.showString("Q");

control.inBackground(function () {
    let blink = false;
    let lastBlink = 0;
    while (true) {
        const now = control.millis();
        qzBase.tick(now);
        if (now - lastBlink >= 500) {
            lastBlink = now;
            blink = !blink;
            // usually Q, with added blinking ! if server not alive
            if (qzBase.serverAlive(now)) { 
                basic.showString("Q");
            } else {
                if (blink){
                    basic.showString("Q");
                } else {
                    basic.showLeds(`
. # # . #
# . . # #
# . . # #
. # # . .
. . # # #
`); 
                }
            }
        }
        basic.pause(1);
    }
});
