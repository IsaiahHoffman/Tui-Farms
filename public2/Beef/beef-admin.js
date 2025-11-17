document.getElementById("addButton").addEventListener("click", addItem);


const itemList = document.getElementById("itemList");

const sortable = Sortable.create(itemList, {
  animation: 150,
  onEnd: function () {
    updateServerList();
  }
});




function addItem() {
  const itemInput = document.getElementById("itemInput");
  const quantityInput = document.getElementById("quantityInput");
  const priceInput = document.getElementById("priceInput");

  const itemName = itemInput.value.trim();
  const quantity = parseInt(quantityInput.value, 10);
  const price = parseFloat(priceInput.value);

  if (!itemName) {
    alert("Enter a valid item name.");
    return;
  }
  if (isNaN(quantity) || quantity < 0) {
    alert("Enter a valid quantity (0 or more).");
    return;
  }
  if (isNaN(price) || price < 0) {
    alert("Enter a valid price (0 or more).");
    return;
  }

  const existing = findItemElement(itemName);
  if (existing) {
    // If item exists, update quantity and price
    existing.dataset.quantity = parseInt(existing.dataset.quantity) + quantity;
    existing.dataset.price = price;
    updateListItemText(existing);
  } else {
    createListItem(itemName, quantity, price);
  }

  itemInput.value = "";
  quantityInput.value = "0";
  priceInput.value = "";
  updateServerList();
}

function createListItem(name, quantity, price) {
  const li = document.createElement("li");
  li.dataset.name = name;
  li.dataset.quantity = quantity;
  li.dataset.price = price.toFixed(2);

  li.innerHTML = `
    <span class="item-text"></span>
    <div>
      <button class="increase-btn">+</button>
      <button class="decrease-btn">-</button>
      <button class="edit-price-btn">✏️</button>
      <button class="remove-btn">❌</button>
    </div>
  `;

  updateListItemText(li);

  li.querySelector(".increase-btn").addEventListener("click", () => {
    li.dataset.quantity = parseInt(li.dataset.quantity) + 1;
    updateListItemText(li);
    updateServerList();
  });

  li.querySelector(".decrease-btn").addEventListener("click", () => {
    let qty = parseInt(li.dataset.quantity);
    if (qty > 0) {
      li.dataset.quantity = qty - 1;
      updateListItemText(li);
      updateServerList();
    }
  });

  li.querySelector(".edit-price-btn").addEventListener("click", () => {
    const newPriceStr = prompt("Enter new price:", li.dataset.price);
    if (newPriceStr !== null) {
      const newPrice = parseFloat(newPriceStr);
      if (!isNaN(newPrice) && newPrice >= 0) {
        li.dataset.price = newPrice.toFixed(2);
        updateListItemText(li);
        updateServerList();
      } else {
        alert("Invalid price entered.");
      }
    }
  });

  li.querySelector(".remove-btn").addEventListener("click", () => {
    li.remove();
    updateServerList();
  });

  document.getElementById("itemList").appendChild(li);
}

function updateListItemText(li) {
  const textSpan = li.querySelector(".item-text");
  const name = li.dataset.name;
  const qty = li.dataset.quantity;
  const price = li.dataset.price;
  textSpan.textContent = `${name} - Qty: ${qty} - Price/lb: $${price}`;
}

function findItemElement(nameToFind) {
  const listItems = document.querySelectorAll("#itemList li");
  for (let li of listItems) {
    if (li.dataset.name === nameToFind) {
      return li;
    }
  }
  return null;
}

function updateServerList() {
  const listItems = document.querySelectorAll("#itemList li");
  const items = [];

  listItems.forEach((li) => {
    // Format: name | quantity | price
    items.push(`${li.dataset.name} | ${li.dataset.quantity} | ${li.dataset.price}`);
  });

  fetch("/update-list", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ items }),
  }).catch((err) => console.error("Failed to update server:", err));
}

// Load initial list from server on page load (if you want)
function loadInitialList() {
  fetch("/load-list")
    .then(res => res.json())
    .then(data => {
      data.items.forEach(item => {
        // Expecting format: name | quantity | price
        const parts = item.split("|").map(s => s.trim());
        if (parts.length === 3) {
          const name = parts[0];
          const quantity = parseInt(parts[1], 10);
          const price = parseFloat(parts[2]);
          if (name && !isNaN(quantity) && !isNaN(price)) {
            createListItem(name, quantity, price);
          }
        }
      });
    })
    .catch(err => console.error("Failed to load initial list:", err));
}

loadInitialList();
