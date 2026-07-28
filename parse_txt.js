const fs = require('fs');
const path = require('path');

const srcPath = 'C:\\Users\\THAI ANH\\Downloads\\Xuyên qua thành phản diện, thích nhất ngay mặt NTR (1-60 chương).txt';
const destPath = path.join(__dirname, 'book_data.js');

try {
  console.log(`Đang đọc file truyện từ: ${srcPath}...`);
  if (!fs.existsSync(srcPath)) {
    console.error(`Lỗi: Không tìm thấy file truyện tại ${srcPath}`);
    process.exit(1);
  }

  const rawText = fs.readFileSync(srcPath, 'utf8');
  const lines = rawText.split(/\r?\n/);
  
  const chapters = [];
  let currentChapter = {
    title: "Mở đầu / Giới thiệu",
    paragraphs: []
  };

  // Biểu thức chính quy phát hiện tiêu đề chương
  // Hỗ trợ dạng: "Thứ X chương", "Chương X", "Chapter X"
  const chapterRegex = /^\s*(Thứ\s+\d+\s+chương|Chương\s+\d+|Chapter\s+\d+)/i;

  for (let line of lines) {
    const trimmedLine = line.trim();
    if (trimmedLine === "") continue;

    if (chapterRegex.test(trimmedLine)) {
      // Nếu chương hiện tại có nội dung, lưu lại
      if (currentChapter.paragraphs.length > 0 || currentChapter.title !== "Mở đầu / Giới thiệu") {
        chapters.push(currentChapter);
      }
      // Tạo chương mới
      currentChapter = {
        title: trimmedLine,
        paragraphs: []
      };
    } else {
      // Thêm dòng vào danh sách các đoạn văn của chương hiện tại
      currentChapter.paragraphs.push(trimmedLine);
    }
  }

  // Đẩy chương cuối cùng vào mảng
  if (currentChapter.paragraphs.length > 0 || currentChapter.title !== "Mở đầu / Giới thiệu") {
    chapters.push(currentChapter);
  }

  console.log(`Đã phân tích xong. Tổng số chương: ${chapters.length}`);

  // Xuất file JS để nhúng trực tiếp vào HTML (chạy cục bộ không bị CORS)
  const bookDataContent = `// Tự động sinh ra bởi parse_txt.js. Đừng sửa đổi trực tiếp file này.
window.defaultStory = {
  title: "Xuyên qua thành phản diện, thích nhất ngay mặt NTR (1-60 chương)",
  chapters: ${JSON.stringify(chapters, null, 2)}
};
`;

  fs.writeFileSync(destPath, bookDataContent, 'utf8');
  console.log(`Đã ghi file dữ liệu truyện ra: ${destPath}`);

} catch (error) {
  console.error("Đã xảy ra lỗi trong quá trình phân tích truyện:", error);
}
