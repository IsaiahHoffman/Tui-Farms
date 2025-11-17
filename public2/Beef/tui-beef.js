async function loadProducts() {
  const res = await fetch('/load-list');
  const data = await res.json();

  const container = document.getElementById('product-list');

  data.items.forEach(itemLine => {
    const parts = itemLine.split('|').map(s => s.trim());
    if (parts.length !== 3) return;

    const [name, quantityStr, priceStr] = parts;
    const quantity = parseInt(quantityStr, 10);
    const price = parseFloat(priceStr);

    if (!name || isNaN(quantity) || isNaN(price)) return;

    const div = document.createElement('div');
    div.className = 'product';
    div.innerHTML = `
      <span class="name"><strong>${name}</strong></span><br />
      <span class="price">Price: $${price.toFixed(2)}/lb</span><br />
      <span class="stock">Available: ${quantity}</span>
      <div class="order-controls">
        <button class="decrease-btn" disabled>-</button>
        <input type="number" class="order-qty" value="0" min="0" max="${quantity}" readonly />
        <button class="increase-btn">+</button>
      </div>
    `;

    const decreaseBtn = div.querySelector('.decrease-btn');
    const increaseBtn = div.querySelector('.increase-btn');
    const qtyInput = div.querySelector('.order-qty');

    function updateCart() {
      const cartItemsUl = document.getElementById('cart-items');
      const cartTotalSpan = document.getElementById('cart-total');

      // Gather all products with qty > 0
      const products = document.querySelectorAll('.product');
      const cartItems = [];
      let total = 0;

      products.forEach(prod => {
        const qty = parseInt(prod.querySelector('.order-qty').value);
        if (qty > 0) {
          const productName = prod.querySelector('.name strong').textContent;
          const priceText = prod.querySelector('.price').textContent;
          const price = parseFloat(priceText.match(/\$(\d+(\.\d+)?)/)[1]);
          cartItems.push({ name: productName, qty, price });
          total += qty * price;
        }
      });

      // Clear current list
      cartItemsUl.innerHTML = "";

      // Add current items
      cartItems.forEach(item => {
        const li = document.createElement('li');
        li.textContent = `${item.name} — Qty: ${item.qty}`;
        cartItemsUl.appendChild(li);
      });

      cartTotalSpan.textContent = total.toFixed(2);
    }

    decreaseBtn.addEventListener('click', () => {
      let current = parseInt(qtyInput.value);
      if (current > 0) {
        qtyInput.value = current - 1;
        if (qtyInput.value == 0) decreaseBtn.disabled = true;
        increaseBtn.disabled = false;
        updateCart();
      }
    });

    increaseBtn.addEventListener('click', () => {
      let current = parseInt(qtyInput.value);
      if (current < quantity) {
        qtyInput.value = current + 1;
        if (qtyInput.value == quantity) increaseBtn.disabled = true;
        decreaseBtn.disabled = false;
        updateCart();
      }
    });

    container.appendChild(div);
  });
}

loadProducts();
