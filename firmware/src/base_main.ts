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

// Display: never use basic.showString / showLeds here. They block for hundreds of milliseconds, and this
// loop also sends the beacons and forwards the team packets to the PC: a blocked loop means a deaf base.
const QZ_BASE_Q = [".###.", "#...#", "#.#.#", "#..##", ".####"];
const QZ_BASE_NOSERVER = [".##.#", "#..##", "#..##", ".##..", "..###"];
let qzBaseLastFrame = "";

function qzBaseDraw(rows: string[]) {
    const key = rows.join("");
    if (key == qzBaseLastFrame) return;          // only touch the LEDs when the picture changes
    qzBaseLastFrame = key;
    for (let y = 0; y < 5; y++) {
        for (let x = 0; x < 5; x++) {
            if (rows[y].charAt(x) == "#") led.plot(x, y); else led.unplot(x, y);
        }
    }
}

control.inBackground(function () {
    while (true) {
        const now = control.millis();
        qzBase.tick(now);
        // steady Q while the server is alive; Q and a "no server" picture alternate every 500 ms otherwise
        if (qzBase.serverAlive(now) || (Math.idiv(now, 500) % 2) == 0) qzBaseDraw(QZ_BASE_Q);
        else qzBaseDraw(QZ_BASE_NOSERVER);
        basic.pause(1);
    }
});
