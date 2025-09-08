const express = require("express");
const Products = require("./products.model");
const Reviews = require("../reviews/reviews.model");
const verifyToken = require("../middleware/verifyToken");
const verifyAdmin = require("../middleware/verifyAdmin");
const router = express.Router();

// post a product
const { uploadImages } = require("../utils/uploadImage");

router.post("/uploadImages", async (req, res) => {
    try {
        const { images } = req.body; // images هي مصفوفة من base64
        if (!images || !Array.isArray(images)) {
            return res.status(400).send({ message: "يجب إرسال مصفوفة من الصور" });
        }

        const uploadedUrls = await uploadImages(images);
        res.status(200).send(uploadedUrls);
    } catch (error) {
        console.error("Error uploading images:", error);
        res.status(500).send({ message: "حدث خطأ أثناء تحميل الصور" });
    }
});

// نقطة النهاية لإنشاء منتج
const ALLOWED_CATEGORIES = new Set(["حقائب", "كڤرات", "حماية الشاشة", "إكسسوارات"]);

router.post("/create-product", async (req, res) => {
  try {
    let { name, category, description, oldPrice, price, image, author } = req.body;

    // 1) التحقق من الحقول المطلوبة الأساسية
    if (!name || !category || !description || price == null || !image || !author) {
      return res.status(400).send({ message: "جميع الحقول المطلوبة يجب إرسالها" });
    }

    // 2) التحقق من التصنيف المسموح به
    if (!ALLOWED_CATEGORIES.has(category)) {
      return res.status(400).send({ message: "تصنيف غير مسموح. التصنيفات المتاحة: حقائب، كڤرات، حماية الشاشة، إكسسوارات" });
    }

    // 3) تنظيف وتحويل القيم
    name = String(name).trim();
    description = String(description).trim();

    // تحويل السعر إلى رقم والتحقق منه
    const priceNum = Number(price);
    if (Number.isNaN(priceNum) || priceNum < 0) {
      return res.status(400).send({ message: "قيمة السعر غير صالحة" });
    }

    // oldPrice اختياري: إن أُرسل وكان رقمًا صالحًا نُخزنه، وإلا نتجاهله
    let oldPriceNum;
    if (oldPrice !== undefined && oldPrice !== "") {
      oldPriceNum = Number(oldPrice);
      if (Number.isNaN(oldPriceNum) || oldPriceNum < 0) {
        return res.status(400).send({ message: "قيمة السعر القديم غير صالحة" });
      }
    }

    // 4) الصور: قبول مصفوفة أو سلسلة واحدة
    let images = [];
    if (Array.isArray(image)) {
      images = image.filter(Boolean);
    } else if (typeof image === "string" && image.trim() !== "") {
      images = [image.trim()];
    }

    if (images.length === 0) {
      return res.status(400).send({ message: "يجب إرسال صورة واحدة على الأقل" });
    }

    // 5) إنشاء كائن المنتج (لا يوجد منطق حجم/حناء)
    const productData = {
      name,
      category,
      description,
      price: priceNum,
      image: images,
      author,
    };

    if (oldPriceNum !== undefined) {
      productData.oldPrice = oldPriceNum;
    }

    // 6) الحفظ
    const newProduct = new Products(productData);
    const savedProduct = await newProduct.save();

    return res.status(201).send(savedProduct);
  } catch (error) {
    console.error("Error creating new product", error);
    return res.status(500).send({ message: "Failed to create new product" });
  }
});


// get all products
router.get("/", async (req, res) => {
  try {
    const {
      category,
      size,
      color,
      minPrice,
      maxPrice,
      page = 1,
      limit = 10,
    } = req.query;

    const filter = {};

    if (category && category !== "all") {
      filter.category = category;
      
      // إذا كانت الفئة حناء بودر وكان هناك حجم محدد
      if (category === 'حناء بودر' && size) {
        filter.size = size;
      }
    }

    if (color && color !== "all") {
      filter.color = color;
    }

    if (minPrice && maxPrice) {
      const min = parseFloat(minPrice);
      const max = parseFloat(maxPrice);
      if (!isNaN(min) && !isNaN(max)) {
        filter.price = { $gte: min, $lte: max };
      }
    }

    const skip = (parseInt(page) - 1) * parseInt(limit);
    const totalProducts = await Products.countDocuments(filter);
    const totalPages = Math.ceil(totalProducts / parseInt(limit));

    const products = await Products.find(filter)
      .skip(skip)
      .limit(parseInt(limit))
      .populate("author", "email")
      .sort({ createdAt: -1 });

    res.status(200).send({ products, totalPages, totalProducts });
  } catch (error) {
    console.error("Error fetching products:", error);
    res.status(500).send({ message: "Failed to fetch products" });
  }
});

//   get single Product
// get single Product (يدعم كلا المسارين)
router.get(["/:id", "/product/:id"], async (req, res) => {
  try {
    const productId = req.params.id;
    const product = await Products.findById(productId).populate(
      "author",
      "email username"
    );
    if (!product) {
      return res.status(404).send({ message: "Product not found" });
    }
    const reviews = await Reviews.find({ productId }).populate(
      "userId",
      "username email"
    );
    res.status(200).send({ product, reviews });
  } catch (error) {
    console.error("Error fetching the product", error);
    res.status(500).send({ message: "Failed to fetch the product" });
  }
});

// update a product
const multer = require('multer');
const upload = multer();

router.patch(
  "/update-product/:id",
  verifyToken,
  verifyAdmin,
  upload.array("image", 10), // ⬅️ دعم رفع أكثر من صورة
  async (req, res) => {
    try {
      const productId = req.params.id;

      // اجلب المنتج الحالي للاعتماد عليه عند عدم رفع صور جديدة
      const existing = await Products.findById(productId);
      if (!existing) {
        return res.status(404).send({ message: "المنتج غير موجود" });
      }

      // تجهيز الحقول
      const name = req.body.name?.trim();
      const category = req.body.category;
      const description = req.body.description?.trim();
      const price = req.body.price;
      const oldPrice = req.body.oldPrice;

      // تحقق أساسي
      if (!name || !category || !description || price == null) {
        return res.status(400).send({ message: "جميع الحقول المطلوبة يجب إرسالها" });
      }

      // التحقق من التصنيف
      if (!ALLOWED_CATEGORIES.has(category)) {
        return res
          .status(400)
          .send({ message: "تصنيف غير مسموح. المتاح: حقائب، كڤرات، حماية الشاشة، إكسسوارات" });
      }

      // تحويل الأسعار
      const priceNum = Number(price);
      if (Number.isNaN(priceNum) || priceNum < 0) {
        return res.status(400).send({ message: "قيمة السعر غير صالحة" });
      }

      let oldPriceNum;
      if (oldPrice !== undefined && oldPrice !== "") {
        oldPriceNum = Number(oldPrice);
        if (Number.isNaN(oldPriceNum) || oldPriceNum < 0) {
          return res.status(400).send({ message: "قيمة السعر القديم غير صالحة" });
        }
      }

      // الصور:
      // إذا جاءتنا ملفات جديدة -> استبدال الصور بالكامل بالمسارات/الروابط التي تحددها
      // ملاحظة: req.files هنا بايتات في الذاكرة، عادةً ترفعها لخدمة تخزين ثم تحفظ الروابط.
      // لأجل المثال سنحفظ "مسارات وهمية" أو "buffer طول" (عدّل بحسب بنية مشروعك).
      let images = existing.image || [];

      if (req.files && req.files.length > 0) {
        // TODO: ارفع req.files إلى S3/Cloudinary وأعد قائمة الروابط بدل السطور التالية
        images = req.files.map((f, idx) => {
          // مثال placeholder يبين أين تحفظ الرابط الحقيقي للملف بعد رفعه
          return `/uploads/${productId}/${Date.now()}_${idx}.bin`;
        });
      } else if (req.body.image) {
        // دعم مرور روابط جاهزة عبر body.image (سلسلة واحدة أو JSON Array)
        if (Array.isArray(req.body.image)) {
          images = req.body.image.filter(Boolean);
        } else if (typeof req.body.image === "string") {
          try {
            const parsed = JSON.parse(req.body.image);
            if (Array.isArray(parsed)) images = parsed.filter(Boolean);
            else if (req.body.image.trim()) images = [req.body.image.trim()];
          } catch {
            if (req.body.image.trim()) images = [req.body.image.trim()];
          }
        }
      }

      if (!images || images.length === 0) {
        return res.status(400).send({ message: "يجب إرفاق صورة واحدة على الأقل أو إبقاء القديمة" });
      }

      const updateData = {
        name,
        category,
        description,
        price: priceNum,
        image: images,
        author: req.body.author || existing.author, // لا تغيّر المالك لو ما أُرسل
      };

      if (oldPriceNum !== undefined) {
        updateData.oldPrice = oldPriceNum;
      } else {
        updateData.oldPrice = null; // أو اتركه بدون تغيير: احذف هذا السطر لو تريده يبقى كما هو
      }

      const updatedProduct = await Products.findByIdAndUpdate(
        productId,
        { $set: updateData },
        { new: true, runValidators: true }
      );

      if (!updatedProduct) {
        return res.status(404).send({ message: "المنتج غير موجود" });
      }

      return res.status(200).send({
        message: "تم تحديث المنتج بنجاح",
        product: updatedProduct,
      });
    } catch (error) {
      console.error("خطأ في تحديث المنتج", error);
      return res.status(500).send({
        message: "فشل تحديث المنتج",
        error: error.message,
      });
    }
  }
);

// delete a product

router.delete("/:id", async (req, res) => {
  try {
    const productId = req.params.id;
    const deletedProduct = await Products.findByIdAndDelete(productId);

    if (!deletedProduct) {
      return res.status(404).send({ message: "Product not found" });
    }

    // delete reviews related to the product
    await Reviews.deleteMany({ productId: productId });

    res.status(200).send({
      message: "Product deleted successfully",
    });
  } catch (error) {
    console.error("Error deleting the product", error);
    res.status(500).send({ message: "Failed to delete the product" });
  }
});

// get related products
router.get("/related/:id", async (req, res) => {
  try {
    const { id } = req.params;

    if (!id) {
      return res.status(400).send({ message: "Product ID is required" });
    }
    const product = await Products.findById(id);
    if (!product) {
      return res.status(404).send({ message: "Product not found" });
    }

    const titleRegex = new RegExp(
      product.name
        .split(" ")
        .filter((word) => word.length > 1)
        .join("|"),
      "i"
    );

    const relatedProducts = await Products.find({
      _id: { $ne: id }, // Exclude the current product
      $or: [
        { name: { $regex: titleRegex } }, // Match similar names
        { category: product.category }, // Match the same category
      ],
    });

    res.status(200).send(relatedProducts);

  } catch (error) {
    console.error("Error fetching the related products", error);
    res.status(500).send({ message: "Failed to fetch related products" });
  }
});

module.exports = router;
