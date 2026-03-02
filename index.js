//Version 14 on 16 Dec 2025, 11.12
//Watermark 1.1
//https://script.google.com/macros/s/AKfycbwaT9RmkmJki_wFTUuFTAzpvJQY7tjTE-U8s50jD31D1XZNO_vHLh6cxKxxdvU6rq0u/exec

/****************************************************
 * ABSENSI ONLINE DISDUKCAPIL MAJENE
 * Versi 2025-11 (Logging Edition)
 * - Prev-first TELAT + anti-dup + multi-frag keterangan
 * - Role 1x (Penjaga Malam/Kebersihan)
 * - Apel (Sen–Kam), Config dinamis dari sheet 'Config'
 * - GEO ketat, Upload selfie/bukti ke Drive
 * - NEW: Sheet 'Logs' (audit trail) via logEvent_ + logAndReturn
 ****************************************************/

/************** KONFIGURASI INTI (SESUAIKAN) **************/
const APP_KEY        = 'absendukcapilmajene';
const SPREADSHEET_ID = '11lU4f6s5cMBMMEIftwr1B0mRQO4s8RFQ4kw82rWm1AI';
const FOLDER_ID      = '1XuISKcA79uKBEOOYmvZoGQ5YnXpRAN1o';
const TZ             = 'Asia/Makassar';

const ROLES = { REGULER:'reguler', PENJAGA_MALAM:'penjaga malam', KEBERSIHAN:'kebersihan' };

/************** ENTRY POINT **************/
function doPost(e) {
  try {
    const p = (e && e.parameter) || {};
    const key = (p.key || '').trim();
    if (APP_KEY && key !== APP_KEY) {
      const resp = { ok:false, message:'Unauthorized', code:'UNAUTHORIZED' };
      return logAndReturn(resp, { aksi:'CONFIG', serverTime:tsNow_() });
    }

    // CONFIG fetch (tanpa NIP/Nama)
    if (p.config === 'true') {
      const cfg = getConfig_();
      const resp = cfg.ok ? cfg : { ok:false, message:'Config not OK', code:'CONFIG_ERROR' };
      return logAndReturn(resp, { aksi:'CONFIG', serverTime:tsNow_() });
    }

    // Open sheets
    const ss = SpreadsheetApp.openById(SPREADSHEET_ID);
    const shPegawai = ss.getSheetByName('Pegawai');
    const shAbsen   = ss.getSheetByName('Absensi');
    if (!shPegawai || !shAbsen) {
      const resp = { ok:false, message:'❌ Sheet tidak ditemukan', code:'SHEET_NOT_FOUND', serverTime:tsNow_() };
      return logAndReturn(resp, { aksi:'SYSTEM' });
    }

    // Load config
    const CFG = getConfig_();
    if (!CFG.ok) {
      const resp = { ok:false, message:'❌ Config error: '+(CFG.error||''), code:'CONFIG_ERROR', serverTime:tsNow_() };
      return logAndReturn(resp, { aksi:'CONFIG' });
    }

    // Params
    const nip         = (p.nip || '').trim();
    const status      = (p.status || '').toLowerCase(); // izin/sakit/pulang cepat
    const ket         = p.keterangan || '';
    const riwayatOnly = p.riwayat === 'true';
    const force       = p.force === 'true';
    const checkOnly   = p.checkOnly === 'true';
    const apel        = (p.apel || '').toLowerCase() === 'true';

    const lat      = safeNum_(p.lat);
    const lng      = safeNum_(p.lng);
    const accuracy = safeNum_(p.accuracy);

    const fileBase64 = p.file || '';
    const fileType   = (p.fileType || '').toLowerCase();
    const fileName   = p.fileName || '';

    const selfieBase64 = p.selfie || '';
    const selfieType   = (p.selfieType || '').toLowerCase();
    const selfieName   = p.selfieName || 'selfie.jpg';

    // Waktu
    const now = new Date();
    const jamFull = Utilities.formatDate(now, TZ, 'HH:mm:ss');
    const tanggalFull = Utilities.formatDate(now, TZ, 'EEEE, dd MMMM yyyy');
    const jamHHmm = Utilities.formatDate(now, TZ, 'HH:mm');
    const jamTotal = toMinutes_(jamHHmm);

    // Pegawai
    const pegData = shPegawai.getDataRange().getValues(); // A:NIP, B:Nama, G:Jadwal, H:Role
    const rowPeg  = pegData.slice(1).find(rec => String(rec[0]) === nip);
    const nama    = rowPeg ? String(rowPeg[1]||'') : '';
    if (!nama) {
      const resp = { ok:false, message:'❌ NIP tidak terdaftar', code:'NIP_NOT_FOUND', serverTime:jamFull };
      return logAndReturn(resp, { nip, nama:'', aksi:'LOOKUP', lat, lng, accuracy });
    }

    const jadwal   = (rowPeg[6]||'full').toLowerCase(); // full/tanggal genap/tanggal ganjil
    const role     = getRole_(rowPeg, ROLES);

    // Tanggal efektif
    const eff     = getTanggalEfektifDate_(now, TZ, role, ROLES);
    const tanggal = eff.tanggal;  // dd/MM/yyyy
    const hari    = eff.hari;

// === DINAS LUAR (override radius) ===
const dinasLuar = isDinasLuar_(tanggal, nip);
const IS_DINAS_LUAR = dinasLuar.active === true;

    const tanggalNum = parseInt(tanggal.split('/')[0],10);
    const isGenap = tanggalNum % 2 === 0;

    // Libur & jadwal
    const isKalenderLibur = isHariLibur_(tanggal) || ['Sabtu','Minggu'].includes(hari);
    const isKerjaTambahan = isKerjaTambahan_(tanggal);
    const isLiburKalenderFinal = isKerjaTambahan ? false : isKalenderLibur;

    const skipJadwal = (role===ROLES.PENJAGA_MALAM || role===ROLES.KEBERSIHAN);
    const bolehMasuk = skipJadwal ? true : (
      jadwal==='full' ||
      (jadwal==='tanggal genap' && (isGenap || ['Senin','Jumat'].includes(hari))) ||
      (jadwal==='tanggal ganjil' && (!isGenap || ['Senin','Jumat'].includes(hari)))
    );

    // RIWAYAT SAJA
    if (riwayatOnly) {
      if (role === ROLES.PENJAGA_MALAM) {
        const r1 = ambilRiwayatSingle_(ss, 'Absen_PenjagaMalam', nip, tanggal);
        const resp = { ok:true, message:r1.found?'📄 Riwayat berhasil dimuat.':'📭 Belum ada riwayat.', nama, role, riwayat:r1.riwayat, serverTime:jamFull };
        return logAndReturn(resp, { nip, nama, aksi:'RIWAYAT_SINGLE', lat, lng, accuracy });
      } else if (role === ROLES.KEBERSIHAN) {
        const r2 = ambilRiwayatSingle_(ss, 'Absen_Kebersihan', nip, tanggal);
        const resp = { ok:true, message:r2.found?'📄 Riwayat berhasil dimuat.':'📭 Belum ada riwayat.', nama, role, riwayat:r2.riwayat, serverTime:jamFull };
        return logAndReturn(resp, { nip, nama, aksi:'RIWAYAT_SINGLE', lat, lng, accuracy });
      } else {
        const r3 = ambilRiwayatHariIni_(shAbsen, nip, tanggal, TZ);
        r3.riwayat['Absen Apel'] = sudahApelHariIni_(ss, nip, tanggal) ? 'Sudah Apel' : '-';
        const resp = { ok:true, message:r3.found?'📄 Riwayat berhasil dimuat.':'📭 Belum ada riwayat.', nama, role, riwayat:r3.riwayat, serverTime:jamFull };
        return logAndReturn(resp, { nip, nama, aksi:'RIWAYAT_REGULER', lat, lng, accuracy });
      }
    }


// PENGAJUAN IZIN / SAKIT / PULANG CEPAT (SLOT-BASED)
if (['izin','sakit','pulang cepat'].includes(status)) {

  const shIzin = ss.getSheetByName('Izin') || ss.insertSheet('Izin');
  ensureHeader_(shIzin, [
    'Timestamp','Tanggal','NIP','Nama',
    'Slot','Jenis','Keterangan','BuktiURL','Status'
  ]);

let slotIzin = (p.slot || '').toUpperCase();

// 🔁 PULANG CEPAT → OTOMATIS SLOT PULANG
if (status === 'pulang cepat') {
  slotIzin = 'PULANG';
}

if (!['PAGI','SIANG','PULANG'].includes(slotIzin)) {
  const resp = {
    ok:false,
    message:'❌ Slot izin tidak valid.',
    code:'INVALID_SLOT',
    serverTime: jamFull
  };
  return logAndReturn(resp, { nip, nama, aksi:'IZIN' });
}

// 🔒 CEK DUPLIKAT IZIN SLOT (SEMUA STATUS)
if (getIzinSlotAnyStatus_(tanggal, nip, slotIzin)) {
  const resp = {
    ok:false,
    message:'⚠️ Slot ini sudah pernah diajukan izin.',
    code:'IZIN_ALREADY_SUBMITTED',
    serverTime: jamFull
  };
  return logAndReturn(resp, { nip, nama, aksi:'IZIN_DUPLICATE_'+slotIzin });
}

// ⬇️ BARU LANJUT UPLOAD & APPEND
const buktiUrl = fileBase64
  ? uploadToDrive_(fileBase64, fileType||'application/octet-stream',
      `${nip}_${tanggal}_${slotIzin}_${sanitizeFileName_(fileName||'bukti')}`)
  : '';

shIzin.appendRow([
  new Date(),
  tanggal,
  nip,
  nama,
  slotIzin,
  status.toUpperCase(),
  ket,
  buktiUrl,
  'PENDING'
]);


  const resp = {
    ok:true,
    message:`📌 Pengajuan ${status} (${slotIzin}) berhasil dikirim.`,
    code:'IZIN_RECORDED',
    serverTime:jamFull
  };
  return logAndReturn(resp, { nip, nama, aksi:'IZIN_'+slotIzin, note:buktiUrl||'' });
}



// VALIDASI GEO (DINAS LUAR = OVERRIDE)
if (!IS_DINAS_LUAR) {
  if (Number.isFinite(lat)&&Number.isFinite(lng)) {
    const distance = haversine_(lat,lng,CFG.office.lat,CFG.office.lng);
    if (Number.isFinite(accuracy) && CFG.geo.max_accuracy_m && accuracy>CFG.geo.max_accuracy_m && !force) {
      const resp = { ok:false, warning:true, code:'GEO_ACCURACY_WEAK', message:`📶 Akurasi GPS lemah (${Math.round(accuracy)} m).`, serverTime:jamFull };
      return logAndReturn(resp, { nip, nama, aksi:'GEO_CHECK', lat, lng, accuracy });
    }
    if (CFG.geo.max_radius_m && distance>CFG.geo.max_radius_m && !force) {
      const resp = { ok:false, warning:true, code:'GEO_OUT_OF_RADIUS', message:`📍 Di luar radius kantor (${Math.round(distance)} m).`, serverTime:jamFull };
      return logAndReturn(resp, { nip, nama, aksi:'GEO_CHECK', lat, lng, accuracy, note:'dist='+Math.round(distance) });
    }
  } else if (!force) {
    const resp = { ok:false, warning:true, code:'GEO_LOCATION_INVALID', message:'📍 Lokasi tidak valid.', serverTime:jamFull };
    return logAndReturn(resp, { nip, nama, aksi:'GEO_CHECK' });
  }
}

    // PRE-CHECK (tanpa tulis)
    if (checkOnly) {
      if (apel) {
        if (role !== ROLES.REGULER) {
          const resp = { ok:false, warning:true, code:'APEL_ROLE_NOT_ALLOWED', message:'🚫 Apel tidak berlaku untuk peran ini.', serverTime:jamFull };
          return logAndReturn(resp, { nip, nama, aksi:'APEL_PRECHECK', lat, lng, accuracy });
        }
        const allowedDays = ['Senin','Selasa','Rabu','Kamis'];
        if (!allowedDays.includes(hari)) {
          const resp = { ok:false, warning:true, code:'APEL_DAY_NOT_ALLOWED', message:'🚫 Apel hanya Senin–Kamis.', serverTime:jamFull };
          return logAndReturn(resp, { nip, nama, aksi:'APEL_PRECHECK', lat, lng, accuracy });
        }
        if (!inWindow_(jamTotal, CFG.apel.start, CFG.apel.end)) {
          const jamApel = `${CFG.apel.start}–${CFG.apel.end}`;
          const resp = { ok:false, warning:true, code:'APEL_TIME_WINDOW', message:`🚫 Apel hanya pada ${jamApel} Wita.`, serverTime:jamFull };
          return logAndReturn(resp, { nip, nama, aksi:'APEL_PRECHECK', lat, lng, accuracy });
        }
      } else {
        if ((!bolehMasuk || isLiburKalenderFinal) && !skipJadwal && !force) {
          const resp = { ok:false, warning:true, code:'OUT_OF_SCHEDULE', message:`⚠️ Hari ini ${hari}${isLiburKalenderFinal?' (libur)':''}, bukan jadwal kerja Anda.`, serverTime:jamFull };
          return logAndReturn(resp, { nip, nama, aksi:'REGULER_PRECHECK', lat, lng, accuracy });
        }
      }
      const resp = { ok:true, warning:false, code:'PRECHECK_OK', message:'✅ Valid, lanjutkan.', nama: nama, serverTime:jamFull, serverDate: tanggalFull };
      return logAndReturn(resp, { nip, nama, aksi: apel?'APEL_PRECHECK':'REGULER_PRECHECK', lat, lng, accuracy });
    }

    // APEL (reguler; tanpa selfie)
    if (apel) {
      if (role!==ROLES.REGULER) {
        const resp = { ok:false, message:'🚫 Apel hanya untuk pegawai reguler.', code:'APEL_ROLE_NOT_ALLOWED', serverTime:jamFull };
        return logAndReturn(resp, { nip, nama, aksi:'APEL', lat, lng, accuracy });
      }
      const allowedDays = ['Senin','Selasa','Rabu','Kamis'];
      if (!allowedDays.includes(hari)) {
        const resp = { ok:false, message:'🚫 Apel hanya Senin–Kamis.', code:'APEL_DAY_NOT_ALLOWED', serverTime:jamFull };
        return logAndReturn(resp, { nip, nama, aksi:'APEL', lat, lng, accuracy });
      }
      if (!inWindow_(jamTotal, CFG.apel.start, CFG.apel.end)) {
        const jamApel = `${CFG.apel.start}–${CFG.apel.end}`;
        const resp = { ok:false, message:`🚫 Apel hanya pada ${jamApel} Wita.`, code:'APEL_TIME_WINDOW', serverTime:jamFull };
        return logAndReturn(resp, { nip, nama, aksi:'APEL', lat, lng, accuracy });
      }
      const shApel = ss.getSheetByName('Absen_Apel') || ss.insertSheet('Absen_Apel');
      ensureHeader_(shApel, ['Timestamp','NIP','Nama','Jam','Lat','Lng','Accuracy']);
      const sudahApel = sudahApelHariIni_(ss, nip, tanggal);
      if (sudahApel) {
        const resp = { ok:false, message:'⚠️ Anda sudah absen apel hari ini.', code:'APEL_ALREADY_DONE', serverTime:jamFull };
        return logAndReturn(resp, { nip, nama, aksi:'APEL', lat, lng, accuracy });
      }
      shApel.appendRow([new Date(), nip, nama, jamHHmm, lat||'', lng||'', accuracy||'' ]);
      const resp = { ok:true, message:`✅ Apel berhasil pukul ${jamHHmm}`, code:'APEL_OK', nama, role, serverTime:jamFull };
      return logAndReturn(resp, { nip, nama, aksi:'APEL', lat, lng, accuracy });
    }

    /************** ABSEN 1x (PENJAGA MALAM & KEBERSIHAN) **************/
    if (role === ROLES.PENJAGA_MALAM || role === ROLES.KEBERSIHAN) {
      const sheetName = (role === ROLES.PENJAGA_MALAM) ? 'Absen_PenjagaMalam' : 'Absen_Kebersihan';
      const shSingle = ss.getSheetByName(sheetName) || ss.insertSheet(sheetName);
      ensureHeader_(shSingle, ['Timestamp','NIP','Nama','Jam','Lat','Lng','Accuracy','SelfieURL']);

      const dataSingle = shSingle.getDataRange().getValues();
      const sudahSingle = dataSingle.slice(1).some(rec => {
        const tgl = Utilities.formatDate(new Date(rec[0]), TZ, 'dd/MM/yyyy');
        return tgl === tanggal && String(rec[1]) === nip;
      });
      if (sudahSingle) {
        const resp = { ok:false, message:'⚠️ Anda sudah absen hari ini.', code:'ALREADY_CHECKED_IN', serverTime:jamFull };
        return logAndReturn(resp, { nip, nama, aksi:'SINGLE', lat, lng, accuracy });
      }

      if (CFG.upload.selfie_required && !isImageMime_(selfieType)) {
        const resp = { ok:false, message:'📸 Selfie harus berupa gambar.', code:'SELFIE_MIME_INVALID', serverTime:jamFull };
        return logAndReturn(resp, { nip, nama, aksi:'SINGLE', lat, lng, accuracy });
      }
      if (CFG.upload.selfie_required && tooBig_(selfieBase64, (CFG.upload.max_selfie_mb||5))) {
        const resp = { ok:false, message:`📸 Selfie terlalu besar (> ${CFG.upload.max_selfie_mb||5}MB).`, code:'SELFIE_TOO_LARGE', serverTime:jamFull };
        return logAndReturn(resp, { nip, nama, aksi:'SINGLE', lat, lng, accuracy });
      }

      const selfieUrl = selfieBase64
        ? uploadToDrive_(selfieBase64, selfieType||'image/jpeg', `${nip}_${tanggal}_SELFIE_${jamFull.replace(/[:]/g,'-')}_${sanitizeFileName_(selfieName)}`)
        : '';

      shSingle.appendRow([new Date(), nip, nama, jamHHmm, lat||'', lng||'', accuracy||'', selfieUrl ]);
      const resp = { ok:true, message:`✅ Kehadiran tercatat pukul ${jamHHmm}`, code:'SINGLE_OK', nama, role, riwayat:{ 'Kehadiran': jamHHmm }, serverTime:jamFull };
      return logAndReturn(resp, { nip, nama, aksi:'SINGLE', lat, lng, accuracy, note:selfieUrl||'' });
    }

    /************** ABSEN REGULER (3x) — prev-first LATE + anti-dup **************/
    const win = getWindowsFromConfig_(CFG, hari);
let jenis='', timeCol=0, selfieCol=0, slot='';

if (between_(jamTotal, win.masukStart, win.masukEnd)) {
  jenis='Absen Masuk'; timeCol=4; selfieCol=10; slot='PAGI';
}
else if (between_(jamTotal, win.siangStart, win.siangEnd)) {
  jenis='Absen Siang'; timeCol=5; selfieCol=11; slot='SIANG';
}
else if (between_(jamTotal, win.pulangStart, win.pulangEnd)) {
  jenis='Absen Pulang'; timeCol=6; selfieCol=12; slot='PULANG';
}
    else {
      // Di luar jam → validasi GEO dulu
      if (!Number.isFinite(lat) || !Number.isFinite(lng)) {
        const resp = { ok:false, message:`⏳ Belum waktunya absen.`, code:'OUT_OF_WINDOW_TOO_EARLY', serverTime:jamFull };
        return logAndReturn(resp, { nip, nama, aksi:'REGULER', lat, lng, accuracy });
      }
      const dist = haversine_(lat, lng, CFG.office.lat, CFG.office.lng);
      if (CFG.geo.max_radius_m && Number.isFinite(dist) && dist > CFG.geo.max_radius_m) {
        const resp = { ok:false, message:`📍 Di luar radius kantor.`, code:'GEO_OUT_OF_RADIUS', serverTime:jamFull };
        return logAndReturn(resp, { nip, nama, aksi:'REGULER', lat, lng, accuracy, note:'dist='+Math.round(dist) });
      }
      if (CFG.geo.max_accuracy_m && Number.isFinite(accuracy) && accuracy > CFG.geo.max_accuracy_m) {
        const resp = { ok:false, message:`📶 Akurasi GPS lemah (${Math.round(accuracy)} m).`, code:'GEO_ACCURACY_WEAK', serverTime:jamFull };
        return logAndReturn(resp, { nip, nama, aksi:'REGULER', lat, lng, accuracy });
      }

      // Definisi slot
      const slots = [
        { jenis:'Absen Masuk',  start:win.masukStart,  end:win.masukEnd,  timeCol:4, selfieCol:10 },
        { jenis:'Absen Siang',  start:win.siangStart,  end:win.siangEnd,  timeCol:5, selfieCol:11 },
        { jenis:'Absen Pulang', start:win.pulangStart, end:win.pulangEnd, timeCol:6, selfieCol:12 },
      ];

      // Cari slot sebelumnya yang sudah berakhir (prev)
      const prevSlot = [...slots].reverse().find(s => s.end!=null && jamTotal > s.end);
      if (prevSlot) {
        let idx = findRowIndex_(shAbsen, nip, tanggal);
        if (idx<0){ shAbsen.appendRow([eff.dateObj,nip,nama,'','','','','','','','','']); idx = shAbsen.getLastRow()-1; }
        const row = idx+1;
        const existing = shAbsen.getRange(row,1,1,12).getValues()[0];

        // Anti-dup: bila slot TELAT sudah tercatat → arahkan ke slot berikutnya / all done
        const ketSaatIni = String(existing[7]||'').trim();
        const fragPrev   = `Telat absen (${prevSlot.jenis})`;
        const sudahTelatSlotIni = !!existing[prevSlot.timeCol-1] || (ketSaatIni.indexOf(fragPrev) >= 0);
        if (sudahTelatSlotIni) {
          const nextSlot = slots.find(s => s.start!=null && jamTotal < s.start);
          if (nextSlot) {
            const startStr = timeStrFromMinutes_(nextSlot.start);
            const endStr   = (nextSlot.end!=null) ? ('–'+timeStrFromMinutes_(nextSlot.end)) : '';
            const resp = { ok:false, message:`⏳ Belum waktunya ${nextSlot.jenis}. Jam ${startStr}${endStr}.`, code:'OUT_OF_WINDOW_TOO_EARLY', serverTime:jamFull };
            return logAndReturn(resp, { nip, nama, aksi:'REGULER', lat, lng, accuracy });
          } else {
            const resp = { ok:false, message:'⏰ Semua window absensi hari ini sudah berakhir.', code:'OUT_OF_WINDOW_ALL_DONE', serverTime:jamFull };
            return logAndReturn(resp, { nip, nama, aksi:'REGULER', lat, lng, accuracy });
          }
        }

        // Pertama kali telat untuk slot ini → simpan jam & TELAT
        if (!existing[prevSlot.timeCol-1]) {
          shAbsen.getRange(row, prevSlot.timeCol).setNumberFormat('@STRING@').setValue(jamHHmm);
        }
        shAbsen.getRange(row,7).setValue('TELAT');

        const newFrag = `Telat absen (${prevSlot.jenis})`;
        const mergedKet = ketSaatIni
          ? (ketSaatIni.indexOf(newFrag) >= 0 ? ketSaatIni : ketSaatIni + '; ' + newFrag)
          : newFrag;
        shAbsen.getRange(row,8).setValue(mergedKet);

        const rAllLate = ambilRiwayatHariIni_(shAbsen, nip, tanggal, TZ);
        rAllLate.riwayat['Absen Apel'] = sudahApelHariIni_(ss, nip, tanggal) ? 'Sudah Apel' : '-';
        rAllLate.riwayat[prevSlot.jenis] = 'Telat absen';

        const resp = { ok:true, message:`⏰ Di luar jam absensi. Dicatat sebagai "Telat absen" untuk ${prevSlot.jenis}.`, code:'OUT_OF_WINDOW_MARKED_LATE', nama, role, riwayat:rAllLate.riwayat, serverTime:jamFull };
        return logAndReturn(resp, { nip, nama, aksi:prevSlot.jenis, lat, lng, accuracy });
      }

      // Sebelum slot pertama → terlalu cepat
      const nextEarly = slots.find(s => s.start!=null && jamTotal < s.start);
      if (nextEarly) {
        const startStr = timeStrFromMinutes_(nextEarly.start);
        const endStr   = (nextEarly.end!=null) ? ('–'+timeStrFromMinutes_(nextEarly.end)) : '';
        const resp = { ok:false, message:`⏳ Belum waktunya ${nextEarly.jenis}. Jam ${startStr}${endStr}.`, code:'OUT_OF_WINDOW_TOO_EARLY', serverTime:jamFull };
        return logAndReturn(resp, { nip, nama, aksi:'REGULER', lat, lng, accuracy });
      }

      // Fallback teoretis: tandai telat pulang
      const target = { jenis:'Absen Pulang', timeCol:6, selfieCol:12 };
      let idx2 = findRowIndex_(shAbsen, nip, tanggal);
      if (idx2<0){ shAbsen.appendRow([eff.dateObj,nip,nama,'','','','','','','','','']); idx2 = shAbsen.getLastRow()-1; }
      const row2 = idx2+1;
      const existing2 = shAbsen.getRange(row2,1,1,12).getValues()[0];

      if (!existing2[target.timeCol-1]) {
        shAbsen.getRange(row2, target.timeCol).setNumberFormat('@STRING@').setValue(jamHHmm);
      }
      shAbsen.getRange(row2,7).setValue('TELAT');

      const ketSaatIni2 = String(existing2[7]||'').trim();
      const newFrag2 = `Telat absen (${target.jenis})`;
      const mergedKet2 = ketSaatIni2
        ? (ketSaatIni2.indexOf(newFrag2) >= 0 ? ketSaatIni2 : ketSaatIni2 + '; ' + newFrag2)
        : newFrag2;
      shAbsen.getRange(row2,8).setValue(mergedKet2);

      const rAllLate2 = ambilRiwayatHariIni_(shAbsen, nip, tanggal, TZ);
      rAllLate2.riwayat['Absen Apel'] = sudahApelHariIni_(ss, nip, tanggal) ? 'Sudah Apel' : '-';
      rAllLate2.riwayat[target.jenis] = 'Telat absen';

      const resp = { ok:true, message:`⏰ Di luar jam absensi. Dicatat sebagai "Telat absen" untuk ${target.jenis}.`, code:'OUT_OF_WINDOW_MARKED_LATE', nama, role, riwayat:rAllLate2.riwayat, serverTime:jamFull };
      return logAndReturn(resp, { nip, nama, aksi:target.jenis, lat, lng, accuracy });
    }

    // SIMPAN (REGULER) di dalam window
    let idx3 = findRowIndex_(shAbsen, nip, tanggal);
    if (idx3<0){ shAbsen.appendRow([eff.dateObj,nip,nama,'','','','','','','','','']); idx3 = shAbsen.getLastRow()-1; }
    const row3 = idx3+1;
    const rowData = shAbsen.getRange(row3,1,1,12).getValues()[0];

const izinSlot = getIzinSlot_(tanggal, nip, slot);
if (izinSlot) {
  const resp = {
    ok:false,
    message:`⚠️ Slot ${slot} sudah ${izinSlot.jenis}.`,
    code:'SLOT_ALREADY_IZIN',
    serverTime: jamFull
  };
  return logAndReturn(resp, { nip, nama, aksi:'ABSEN_'+slot });
}


    if (rowData[timeCol-1]) {
      const rAlready = ambilRiwayatHariIni_(shAbsen,nip,tanggal,TZ);
      rAlready.riwayat['Absen Apel'] = sudahApelHariIni_(ss, nip, tanggal) ? 'Sudah Apel' : '-';
      const resp = { ok:false, message:`⚠️ Sudah ${jenis}.`, code:'ALREADY_CHECKED_IN', riwayat:rAlready.riwayat, serverTime:jamFull };
      return logAndReturn(resp, { nip, nama, aksi:jenis, lat, lng, accuracy });
    }

    if (CFG.upload.selfie_required && !isImageMime_(selfieType)) {
      const resp = { ok:false, message:'📸 Selfie harus berupa gambar.', code:'SELFIE_MIME_INVALID', serverTime:jamFull };
      return logAndReturn(resp, { nip, nama, aksi:jenis, lat, lng, accuracy });
    }
    if (CFG.upload.selfie_required && tooBig_(selfieBase64, (CFG.upload.max_selfie_mb||5))) {
      const resp = { ok:false, message:`📸 Selfie terlalu besar (> ${CFG.upload.max_selfie_mb||5}MB).`, code:'SELFIE_TOO_LARGE', serverTime:jamFull };
      return logAndReturn(resp, { nip, nama, aksi:jenis, lat, lng, accuracy });
    }

    const selfieUrl2 = selfieBase64
      ? uploadToDrive_(selfieBase64, selfieType||'image/jpeg', `${nip}_${tanggal}_${jenis.replace(' ','').toUpperCase()}_${jamFull.replace(/[:]/g,'-')}_${sanitizeFileName_(selfieName)}`)
      : '';

    shAbsen.getRange(row3, timeCol).setNumberFormat('@STRING@').setValue(jamHHmm);
    // Tambahan keterangan DINAS LUAR
if (IS_DINAS_LUAR) {
  const ketCell = shAbsen.getRange(row3, 8); // kolom Keterangan
  const oldKet  = String(ketCell.getValue() || '');
  const dlKet   = 'DINAS LUAR – ' + dinasLuar.keterangan;
  ketCell.setValue(oldKet ? oldKet + '; ' + dlKet : dlKet);
}

    if (selfieUrl2) shAbsen.getRange(row3, selfieCol).setValue(selfieUrl2);

    const rFinal = ambilRiwayatHariIni_(shAbsen,nip,tanggal,TZ);
    rFinal.riwayat['Absen Apel'] = sudahApelHariIni_(ss, nip, tanggal) ? 'Sudah Apel' : '-';
    const resp = { ok:true, message:`✅ ${jenis} berhasil pukul ${jamHHmm}`, code:'REGULAR_OK', nama, role, riwayat:rFinal.riwayat, serverTime:jamFull };
    return logAndReturn(resp, { nip, nama, aksi:jenis, lat, lng, accuracy, note:selfieUrl2||'' });

  } catch(err) {
    const resp = { ok:false, message:'⛔ Error: '+err.message, code:'EXCEPTION', serverTime:tsNow_() };
    return logAndReturn(resp, { aksi:'SYSTEM' });
  }
}

/************** LOGGING **************/
function logAndReturn(resp, ctx) {
  try {
    logEvent_(
      (ctx && ctx.nip) || '',
      (ctx && ctx.nama) || '',
      (ctx && ctx.aksi) || '',
      resp.code || '',
      resp.message || '',
      !!resp.ok,
      (ctx && ctx.lat),
      (ctx && ctx.lng),
      (ctx && ctx.accuracy),
      resp.serverTime || (ctx && ctx.serverTime) || '',
      (ctx && ctx.note) || ''
    );
  } catch (_e) {}
  return jsonOut(resp);
}

function logEvent_(nip, nama, aksi, code, message, ok, lat, lng, accuracy, serverTime, note) {
  const ss = SpreadsheetApp.openById(SPREADSHEET_ID);
  const sh = ss.getSheetByName('Logs') || ss.insertSheet('Logs');
  ensureHeader_(sh, ['Timestamp','NIP','Nama','Aksi','Code','Message','OK','Lat','Lng','Accuracy','ServerTime','Note']);
  sh.appendRow([new Date(), nip||'', nama||'', aksi||'', code||'', message||'', ok, lat||'', lng||'', accuracy||'', serverTime||'', note||'']);
}

function tsNow_(){ return Utilities.formatDate(new Date(), TZ, 'HH:mm:ss'); }

/************** CONFIG & WINDOWS **************/
function getConfig_(){
  const ss = SpreadsheetApp.openById(SPREADSHEET_ID);
  const sh = ss.getSheetByName('Config');
  if (!sh) return { ok:false, error:"Sheet 'Config' tidak ditemukan" };

  const rows = sh.getDataRange().getValues();
  const kv = {};

  rows.forEach(r => {
    const k = String(r[0]||'').trim();
    let v = r[1];
    if (v instanceof Date) v = Utilities.formatDate(v, TZ, 'HH:mm');
    else v = String(v||'').trim();
    if (k) kv[k] = v;
  });

  const toNum  = (s,d=null)=>{ const n=Number(s); return Number.isFinite(n)?n:d; };
  const toBool = (s,d=false)=>{
    const t=String(s||'').toLowerCase();
    if(['true','1','yes','y'].includes(t)) return true;
    if(['false','0','no','n'].includes(t)) return false;
    return d;
  };

  const cfg = {
    ok: true,
    office: {
      lat: toNum(kv['OFFICE_LAT']),
      lng: toNum(kv['OFFICE_LNG'])
    },
    geo: {
      max_radius_m:   toNum(kv['MAX_RADIUS_M'], 50),
      max_accuracy_m: toNum(kv['MAX_ACCURACY_M'], 75)
    },
    apel: {
      start: kv['APEL_START'] || '07:30',
      end:   kv['APEL_END']   || '08:00'
    },
    upload: {
      selfie_required: toBool(kv['SELFIE_REQUIRED'], true),
      max_selfie_mb:   toNum(kv['MAX_SELFIE_MB'], 5),
      max_bukti_mb:    toNum(kv['MAX_BUKTI_MB'], 10)
    }
  };

  cfg.win_simple = {
    SENKAM: {
      masukStart:  kv['SENKAM_MASUK_START'],
      masukEnd:    kv['SENKAM_MASUK_END'],
      siangStart:  kv['SENKAM_SIANG_START'],
      siangEnd:    kv['SENKAM_SIANG_END'],
      pulangStart: kv['SENKAM_PULANG_START'],
      pulangEnd:   kv['SENKAM_PULANG_END']
    },
    JUMAT: {
      masukStart:  kv['JUM_MASUK_START'],
      masukEnd:    kv['JUM_MASUK_END'],
      siangStart:  kv['JUM_SIANG_START'],
      siangEnd:    kv['JUM_SIANG_END'],
      pulangStart: kv['JUM_PULANG_START'],
      pulangEnd:   kv['JUM_PULANG_END']
    }
  };

  if (cfg.office.lat == null || cfg.office.lng == null) {
    cfg.ok = false;
    cfg.error = "OFFICE_LAT / OFFICE_LNG belum diisi di sheet Config.";
  }

  return cfg;
}




function getWindowsFromConfig_(CFG, hari){
  const w = CFG.win_simple || {};
  const isJumat = (hari === 'Jumat');
  const src = isJumat ? w.JUMAT : w.SENKAM;

  const toM = v => v ? toMinutes_(v) : null;

  return {
    masukStart:  toM(src?.masukStart),
    masukEnd:    toM(src?.masukEnd),
    siangStart:  toM(src?.siangStart),
    siangEnd:    toM(src?.siangEnd),
    pulangStart: toM(src?.pulangStart),
    pulangEnd:   toM(src?.pulangEnd)
  };
}


function parseRange_(s){
  const arr = String(s||'').split('-').map(t=>t.trim());
  const a = arr[0] || ''; const b = arr[1] || '';
  return { start: toMinutes_(a), end: toMinutes_(b) };
}

const SLOT_MAP = {
  PAGI:   { col: 4, label: 'Absen Masuk' },
  SIANG:  { col: 5, label: 'Absen Siang' },
  PULANG: { col: 6, label: 'Absen Pulang' }
};

/************** HELPERS **************/
function jsonOut(o){ return ContentService.createTextOutput(JSON.stringify(o)).setMimeType(ContentService.MimeType.JSON); }
function safeNum_(v){ const n=Number(v); return Number.isFinite(n)?n:NaN; }
function toMinutes_(hhmm){
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(hhmm||'').trim());
  if(!m) return null;
  const h=Number(m[1]), mi=Number(m[2]);
  return h*60+mi;
}
function timeStrFromMinutes_(mins){
  const h = Math.floor(mins/60), m = mins%60;
  return (h<10?'0':'')+h+':' + (m<10?'0':'')+m;
}
function between_(val,start,end){
  if (start==null || end==null || val==null) return false;
  return val>=start && val<=end;
}
function inWindow_(val, startHHMM, endHHMM){
  return between_(val, toMinutes_(startHHMM), toMinutes_(endHHMM));
}

function getRole_(row,ROLES){
  const val=(row&&String(row[7]||'').trim().toLowerCase())||ROLES.REGULER;
  if (val===ROLES.PENJAGA_MALAM || val===ROLES.KEBERSIHAN) return val;
  return ROLES.REGULER;
}
function getTanggalEfektifDate_(now,TZ,role,ROLES){
  const d=new Date(now);
  const hour=Number(Utilities.formatDate(d,TZ,'H'));
  if(role===ROLES.PENJAGA_MALAM && hour<8) d.setDate(d.getDate()-1);
  const tanggal=Utilities.formatDate(d,TZ,'dd/MM/yyyy');
  const hariIng=Utilities.formatDate(d,TZ,'EEEE');
  const map={Sunday:'Minggu',Monday:'Senin',Tuesday:'Selasa',Wednesday:'Rabu',Thursday:'Kamis',Friday:'Jumat',Saturday:'Sabtu'};
  return {tanggal, hari:map[hariIng], dateObj:d};
}

function findRowIndex_(sheet, nip, tanggal){
  const data=sheet.getDataRange().getValues();
  const body=data.slice(1);
  const idxBody=body.findIndex(rec => Utilities.formatDate(new Date(rec[0]), TZ, 'dd/MM/yyyy') === tanggal && String(rec[1]) === nip);
  if (idxBody < 0) return -1;
  return idxBody + 1; // offset header
}

function ambilRiwayatHariIni_(sheet,nip,tanggal,TZ){
  const data=sheet.getDataRange().getValues();
  const body=data.slice(1);
  const idxBody=body.findIndex(rec=>Utilities.formatDate(new Date(rec[0]),TZ,'dd/MM/yyyy')===tanggal && String(rec[1])===nip);
let riwayat={'Absen Masuk':'-','Absen Siang':'-','Absen Pulang':'-'};
let found = idxBody >= 0;

// ⬅️ JIKA ADA BARIS ABSENSI, AMBIL JAM
if (idxBody >= 0) {
  const rowIndex = idxBody + 2;
  const rowData = sheet.getRange(rowIndex,1,1,12).getValues()[0];
  riwayat = {
    'Absen Masuk': renderJamCell_(rowData[3],TZ),
    'Absen Siang': renderJamCell_(rowData[4],TZ),
    'Absen Pulang': renderJamCell_(rowData[5],TZ)
  };
}

// 🔁 OVERLAY IZIN (SELALU JALAN, ADA ABSEN ATAU TIDAK)
['PAGI','SIANG','PULANG'].forEach(s => {
  const izin = getIzinSlot_(tanggal, nip, s);
  if (izin && riwayat[SLOT_MAP[s].label] === '-') {
    riwayat[SLOT_MAP[s].label] = izin.jenis;
    found = true; // ⬅️ INI KUNCI
  }
});

return { found, riwayat };

}
function renderJamCell_(v,TZ){
  if (!v) return '-';
  if (Object.prototype.toString.call(v)==='[object Date]' && !isNaN(v)) return Utilities.formatDate(v, TZ, 'HH:mm');
  if (typeof v === 'string') { const m=v.match(/^(\d{1,2}:\d{2})(?::\d{2})?$/); return m?m[1]:'-'; }
  return '-';
}

function ambilRiwayatSingle_(ss, sheetName, nip, tanggal) {
  const sh = ss.getSheetByName(sheetName);
  if (!sh) return { found:false, riwayat:{ 'Kehadiran':'-' } };
  const data = sh.getDataRange().getValues();
  const body = data.slice(1);
  const row = body.find(rec => Utilities.formatDate(new Date(rec[0]), TZ, 'dd/MM/yyyy') === tanggal && String(rec[1]) === nip);
  if (!row) return { found:false, riwayat:{ 'Kehadiran':'-' } };
  const jam = (typeof row[3] === 'string') ? row[3] : Utilities.formatDate(new Date(row[0]), TZ, 'HH:mm');
  return { found:true, riwayat:{ 'Kehadiran': jam } };
}

function haversine_(lat1,lon1,lat2,lon2){
  const R=6371e3,toRad=deg=>deg*Math.PI/180;
  const dLat=toRad(lat2-lat1), dLon=toRad(lon2-lon1);
  const a=Math.sin(dLat/2)**2+Math.cos(toRad(lat1))*Math.cos(toRad(lat2))*Math.sin(dLon/2)**2;
  return R*2*Math.atan2(Math.sqrt(a),Math.sqrt(1-a));
}

function isHariLibur_(tanggal){
  const sh=SpreadsheetApp.openById(SPREADSHEET_ID).getSheetByName('Libur');
  if(!sh) return false;
  const data=sh.getDataRange().getValues();
  return data.slice(1).some(rec=>Utilities.formatDate(new Date(rec[0]),TZ,'dd/MM/yyyy')===tanggal);
}
function isKerjaTambahan_(tanggal){
  const sh=SpreadsheetApp.openById(SPREADSHEET_ID).getSheetByName('Kerja_Tambahan');
  if(!sh) return false;
  const data=sh.getDataRange().getValues();
  return data.slice(1).some(rec=>Utilities.formatDate(new Date(rec[0]),TZ,'dd/MM/yyyy')===tanggal);
}

function sanitizeFileName_(name){
  name=(name||'file.bin').toString();
  name=name.replace(/[\/\\:*?"<>|]+/g,'_').replace(/[^\w.\-() @]+/g,'_');
  if(name.length>120) name=name.slice(0,120);
  if(!name.trim()) name='file.bin';
  return name;
}
function isImageMime_(mime){ return String(mime||'').toLowerCase().startsWith('image/'); }
function tooBig_(base64, maxMB){ if(!base64) return false; const approx=Math.floor((base64.length*3)/4); return approx > maxMB*1024*1024; }

function uploadToDrive_(base64, mime, fileName){
  const raw = Utilities.base64Decode(base64);
  const folder = DriveApp.getFolderById(FOLDER_ID);
  const file = folder.createFile(Utilities.newBlob(raw, mime||'application/octet-stream', fileName));
  try { file.setSharing(DriveApp.Access.ANYONE_WITH_LINK, DriveApp.Permission.VIEW); } catch(_) {}
  return file.getUrl();
}

function ensureHeader_(sh, headers) {
  const last = sh.getLastRow();
  if (last === 0) {
    sh.appendRow(headers);
    sh.setFrozenRows(1);
  } else {
    const num = Math.max(headers.length, sh.getLastColumn());
    const first = sh.getRange(1,1,1,num).getValues()[0];
    let same = true;
    for (let i=0;i<headers.length;i++){
      if (String(first[i]||'').toLowerCase() !== String(headers[i]||'').toLowerCase()) { same=false; break; }
    }
    if (!same) {
      sh.insertRows(1);
      sh.getRange(1,1,1,headers.length).setValues([headers]);
      sh.setFrozenRows(1);
    }
  }
}

function sudahApelHariIni_(ss, nip, tanggal){
  const sh = ss.getSheetByName('Absen_Apel');
  if (!sh) return false;
  const data = sh.getDataRange().getValues();
  return data.slice(1).some(rec=>{
    const tgl=Utilities.formatDate(new Date(rec[0]),TZ,'dd/MM/yyyy');
    return tgl===tanggal && String(rec[1])===nip;
  });
}

function getIzinSlot_(tanggal, nip, slot) {
  const sh = SpreadsheetApp.openById(SPREADSHEET_ID).getSheetByName('Izin');
  if (!sh) return null;

  const data = sh.getDataRange().getValues();
  const row = data.slice(1).find(r =>
    Utilities.formatDate(new Date(r[1]), TZ, 'dd/MM/yyyy') === tanggal &&
    String(r[2]) === nip &&
    String(r[4]).toUpperCase() === slot &&
    String(r[8]).toUpperCase() === 'DISETUJUI'
  );

  if (!row) return null;

  return {
    jenis: String(row[5]), // IZIN / SAKIT / PULANG CEPAT
    ket:   String(row[6] || '')
  };
}
function getIzinSlotAnyStatus_(tanggal, nip, slot) {
  const sh = SpreadsheetApp.openById(SPREADSHEET_ID).getSheetByName('Izin');
  if (!sh) return false;

  const data = sh.getDataRange().getValues();
  return data.slice(1).some(r =>
    Utilities.formatDate(new Date(r[1]), TZ, 'dd/MM/yyyy') === tanggal &&
    String(r[2]) === nip &&
    String(r[4]).toUpperCase() === slot &&
    String(r[8]).toUpperCase() !== 'DITOLAK'
  );
}



/************** DINAS LUAR (OVERRIDE GEO) **************/
function isDinasLuar_(tanggal, nip) {
  const sh = SpreadsheetApp.openById(SPREADSHEET_ID).getSheetByName('Dinas_Luar');
  if (!sh) return { active:false, keterangan:'' };

  const data = sh.getDataRange().getValues();
  for (let i = 1; i < data.length; i++) {
    const tgl = Utilities.formatDate(new Date(data[i][0]), TZ, 'dd/MM/yyyy');
    if (tgl === tanggal && String(data[i][1]) === nip) {
      return {
        active: true,
        keterangan: String(data[i][3] || '').trim()
      };
    }
  }
  return { active:false, keterangan:'' };
}
