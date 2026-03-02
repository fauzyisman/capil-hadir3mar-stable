//Version 8 on 12 Feb 2026, 22:58
//https://script.google.com/macros/s/AKfycbxdDgmBRYTeM8Xzg0dm2hFoIeWk4eAxpX7Crj49LQTo4sLQnwxSM-ML1u51dCSNbqtl/exec

/****************************************************
 * CAPIL HADIR – DETAIL API (FINAL)
 ****************************************************/
const SPREADSHEET_ID = '11lU4f6s5cMBMMEIftwr1B0mRQO4s8RFQ4kw82rWm1AI';
const TZ = 'Asia/Makassar';

/* ===================== ENTRY ===================== */
function doGet(e){
  try{
    const p = e.parameter || {};
    if (String(p.api||'').toLowerCase() !== 'summary')
      return json_({ok:false,message:'Route not found. Gunakan ?api=summary'});

    const nip   = String(p.nip||'').trim();
    const year  = parseInt(p.year,10);
    const month = parseInt(p.month,10);

    if(!nip || !Number.isFinite(year) || !Number.isFinite(month) || month<1 || month>12){
      return json_({ok:false,message:'Param wajib: nip, year, month (1..12)'});
    }

    return json_(apiGetSummary_(nip,year,month));
  }catch(err){
    return json_({ok:false,message:'Error: '+err.message});
  }
}

/* ===================== CORE ===================== */
function apiGetSummary_(nip,year,month){
  const ss = SpreadsheetApp.openById(SPREADSHEET_ID);
  const shAbsen = ss.getSheetByName('Absensi');
  const shApel  = ss.getSheetByName('Absen_Apel');
  const shIzin  = ss.getSheetByName('Izin');
  const shLibur = ss.getSheetByName('Libur');
  const shKT    = ss.getSheetByName('Kerja_Tambahan');

  if(!shAbsen) return {ok:false,message:'Sheet Absensi tidak ditemukan'};

  const m0 = month - 1;
  const start = new Date(year,m0,1);
  const end   = new Date(year,m0+1,1);
const totalDays = new Date(year,month,0).getDate();

const today = new Date();
const currentYear = today.getFullYear();
const currentMonth = today.getMonth() + 1;

let days = totalDays;

// Jika bulan di masa depan → jangan hitung
if (year > currentYear || (year === currentYear && month > currentMonth)) {
  days = 0;
}

// Jika bulan berjalan → hanya sampai hari ini
else if (year === currentYear && month === currentMonth) {
  days = today.getDate();
}

/* ===== MAP PEGAWAI (AMBIL POLA KERJA) ===== */
const shPegawai = ss.getSheetByName('Pegawai');
let polaKerja = 'FULL';

if (shPegawai) {
  const dataPegawai = shPegawai.getDataRange().getValues().slice(1);

  const rowPegawai = dataPegawai.find(r => String(r[0]).trim() === nip);

  if (rowPegawai) {
    const wk = String(rowPegawai[6] || '').toUpperCase(); // kolom G

    if (wk.includes('GANJIL')) polaKerja = 'GANJIL';
    else if (wk.includes('GENAP')) polaKerja = 'GENAP';
    else polaKerja = 'FULL';
  }
}



  /* ===== MAP APEL ===== */
  const apelMap = {};
  if(shApel){
    shApel.getDataRange().getValues().slice(1).forEach(r=>{
      if(String(r[1]||'').trim() !== nip) return;
      const t = fmt_(r[0],'dd/MM/yyyy');
      apelMap[t] = true;
    });
  }

  /* ===== MAP IZIN (OVERLAY) ===== */
  const izinMap = {}; // tgl => {PAGI,SIANG,PULANG}
  if(shIzin){
    shIzin.getDataRange().getValues().slice(1).forEach(r=>{
      if(String(r[2]||'').trim() !== nip) return;
      if(String(r[8]||'').toUpperCase() !== 'DISETUJUI') return;

      const t = fmt_(r[1],'dd/MM/yyyy');
      const slot = String(r[4]||'').toUpperCase();
      const jenis = String(r[5]||'').toUpperCase();

      if(!izinMap[t]) izinMap[t] = {};
      izinMap[t][slot] = jenis;
    });
  }

  /* ===== MAP ABSENSI ===== */
  const rowsAbsen = shAbsen.getDataRange().getValues().slice(1)
    .filter(r => String(r[1]) === nip)
    .filter(r => new Date(r[0]) >= start && new Date(r[0]) < end);

  const nama = rowsAbsen.length ? String(rowsAbsen[0][2]||'') : '';
  const byDate = {};
  rowsAbsen.forEach(r=>{
    const t = fmt_(r[0],'dd/MM/yyyy');
    byDate[t] = r;
  });

  /* ===== MAP LIBUR & KERJA TAMBAHAN ===== */
  const liburSet = new Set();
  if(shLibur){
    shLibur.getDataRange().getValues().slice(1).forEach(r=>{
      liburSet.add(fmt_(r[0],'dd/MM/yyyy'));
    });
  }

  const ktSet = new Set();
  if(shKT){
    shKT.getDataRange().getValues().slice(1).forEach(r=>{
      ktSet.add(fmt_(r[0],'dd/MM/yyyy'));
      liburSet.delete(fmt_(r[0],'dd/MM/yyyy')); // override
    });
  }

  /* ===== HITUNG ===== */
  let tMasuk=0,tSiang=0,tPulang=0,tTelat=0,tIzin=0,tSakit=0,tPC=0,tApel=0,tAlpha=0;
  let totalEfektif = 0;
let totalHadirEfektif = 0; 
  let hariKerja=0, liburCount=0, kerjaTambahanCount=ktSet.size;
  

  const rows=[];

  for(let d=1; d<=days; d++){
    const dt = new Date(year,m0,d);
    const tgl = fmt_(dt,'dd/MM/yyyy');
    const hari = hari_(fmt_(dt,'EEEE'));

    const day = dt.getDay();
    const tanggalNum = dt.getDate();

// ===== POLA KERJA =====
let bukanJadwal = false;

// Senin (1) & Jumat (5) wajib masuk semua
const isWajibMasuk = (day === 1 || day === 5);

if (!isWajibMasuk) {

  if (polaKerja === 'GANJIL' && tanggalNum % 2 === 0) {
    bukanJadwal = true;
  }

  if (polaKerja === 'GENAP' && tanggalNum % 2 !== 0) {
    bukanJadwal = true;
  }

}

    const isWeekend = (day===0 || day===6);

    if (!isWeekend && !bukanJadwal && !liburSet.has(tgl)) {
  hariKerja++;
}
    if(liburSet.has(tgl)) liburCount++;

    let masuk='-', siang='-', pulang='-', status='-', ket='';

    if(byDate[tgl]){
      const r = byDate[tgl];
      masuk = jam_(r[3]);
      siang = jam_(r[4]);
      pulang = jam_(r[5]);
      status = String(r[6]||'-').toUpperCase();
      ket = String(r[7]||'');

      if(masuk!=='-') tMasuk++;
      if(siang!=='-') tSiang++;
      if(pulang!=='-') tPulang++;
      if(status==='TELAT') tTelat++;
    }

// === OVERLAY IZIN (FINAL & BENAR) ===
const iz = izinMap[tgl] || {};

if (iz.PAGI && masuk === '-') {
  masuk = iz.PAGI;
  iz.PAGI === 'SAKIT' ? tSakit++ : tIzin++;
}

if (iz.SIANG && siang === '-') {
  siang = iz.SIANG;
  iz.SIANG === 'SAKIT' ? tSakit++ : tIzin++;
}

if (iz.PULANG && pulang === '-') {
  pulang = iz.PULANG;

  if (iz.PULANG === 'PULANG CEPAT') {
    tPC++;
  } else if (iz.PULANG === 'SAKIT') {
    tSakit++;
  } else {
    tIzin++;
  }
}


    if(apelMap[tgl]) tApel++;
    // ===== STATUS HARIAN =====
    let statusHarian = '-';

    const isLibur = liburSet.has(tgl);
    const isKT = ktSet.has(tgl);

    if ((isWeekend && !isKT) || isLibur || bukanJadwal) {
      statusHarian = 'LIBUR';
    } else if (iz.PAGI || iz.SIANG || iz.PULANG) {
      if (iz.PAGI === 'SAKIT' || iz.SIANG === 'SAKIT' || iz.PULANG === 'SAKIT') {
        statusHarian = 'SAKIT';
      } else if (iz.PULANG === 'PULANG CEPAT') {
        statusHarian = 'PULANG CEPAT';
      } else {
        statusHarian = 'IZIN';
      }
} else if (masuk !== '-' || siang !== '-' || pulang !== '-') {
  statusHarian = (status === 'TELAT') ? 'TELAT' : 'HADIR';
} else {
  if (!isWeekend && !isLibur && !bukanJadwal) {
    statusHarian = 'ALPHA';
  }
}
if (statusHarian === 'ALPHA') tAlpha++;

// ===== PERSENTASE =====
if (statusHarian !== 'LIBUR') {
  totalEfektif++;

  if (['HADIR','TELAT','IZIN','SAKIT','PULANG CEPAT']
        .includes(statusHarian)) {
    totalHadirEfektif++;
  }
}

   rows.push({
  tanggal:tgl,
  hari,
  masuk,
  siang,
  pulang,
  status,
  statusHarian,
  keterangan:ket,
  apel:!!apelMap[tgl]
});

  }

  const persentase =
  totalEfektif > 0
    ? Math.round((totalHadirEfektif / totalEfektif) * 100)
    : 0;

  return {
    ok:true,
    meta:{
      nip, nama, year, month,
      bulanNama: bulan_(month),
      totalHari: days,
      hariKerja,
      libur: liburCount,
      cutiTambahan: kerjaTambahanCount
    },
    totals:{
      hadirMasuk:tMasuk,
      hadirSiang:tSiang,
      hadirPulang:tPulang,
      telat:tTelat,
      izin:tIzin,
      sakit:tSakit,
      pulangCepat:tPC,
      apel:tApel,
      alpha:tAlpha,
      persentase: persentase 
    },
    rows
  };
}



/* ===================== HELPERS ===================== */
function json_(o){
  return ContentService.createTextOutput(JSON.stringify(o))
    .setMimeType(ContentService.MimeType.JSON);
}
function fmt_(d,p){ return Utilities.formatDate(new Date(d),TZ,p); }
function jam_(v){
  if(!v) return '-';
  if(v instanceof Date) return Utilities.formatDate(v,TZ,'HH:mm');
  if(typeof v==='string'){ const m=v.match(/^(\d{1,2}:\d{2})/); return m?m[1]:'-'; }
  return '-';
}
function hari_(e){
  return {Sunday:'Minggu',Monday:'Senin',Tuesday:'Selasa',Wednesday:'Rabu',Thursday:'Kamis',Friday:'Jumat',Saturday:'Sabtu'}[e]||e;
}
function bulan_(m){
  return ['Januari','Februari','Maret','April','Mei','Juni','Juli','Agustus','September','Oktober','November','Desember'][m-1]||m;
}
